﻿import A from 'automerge'
import debug from 'debug'
import { EventEmitter } from 'events'
import * as idb from 'idb/with-async-ittr-cjs'
import { ChangeSet, RepoSnapshot } from './types'

const DB_VERSION = 1
export type RepoEventHandler<T> = (documentId: string, doc: A.Doc<T>) => void

/**
 *
 * ### Storage schema
 *
 * We use a single database with two object stores: `feeds`, containing changesets in sequential
 * order, indexed by documentId; and `snapshots`, containing an actual
 *
 * There is one repo (and one database) per discovery key.
 * ```
 * cevitxe::grid::fancy-lizard (DB)
 *   feeds (object store)
 *     1: { id:1, documentId: abc123, changeSet: [...]}
 *     2: { id:2, documentId: abc123, changeSet: [...]}
 *     3: { id:3, documentId: abc123, changeSet: [...]}
 *     4: { id:4, documentId: qrs567, changeSet: [...]}
 *     5: { id:5, documentId: qrs567, changeSet: [...]}
 *     6: { id:6, documentId: qrs567, changeSet: [...]}
 *   snapshots (object store)
 *     abc123: [snapshot]
 *     qrs567: [snapshot]
 * ```
 */
export class Repo<T = any> extends EventEmitter {
  private log: debug.Debugger

  /**
   * The discovery key is a unique ID for this dataset, used to identify it when seeking peers with
   * whom to synchronize. In the example apps we use randomly generated two-word names like
   * `golden-lizard`. It could also be a UUID.
   */
  private discoveryKey: string

  /**
   * Name to distinguish this application's data from others that this browser might have stored;
   * e.g. `grid` or `todos`.
   */
  private databaseName: string

  /**
   * In-memory map of document snapshots.
   */
  private state: RepoSnapshot<T>

  /**
   * Document change event listeners. Each handler fires every time a document is set or removed.
   */
  private handlers: Set<RepoEventHandler<T>>

  constructor(discoveryKey: string, databaseName: string) {
    super()
    this.discoveryKey = discoveryKey
    this.databaseName = databaseName
    this.log = debug(`cevitxe:repo:${databaseName}`)

    this.state = {}
    this.handlers = new Set()
  }

  /**
   * Initializes the repo and returns a snapshot of its current state.
   * @param initialState The starting state to use when creating a new repo.
   * @param creating Use `true` if creating a new repo, `false` if joining an existing repo (locally
   * or with a peer)
   * @returns A snapshot of the repo's current state.
   */
  async init(initialState: any, creating: boolean): Promise<RepoSnapshot> {
    const hasData = await this.hasData()
    this.log('hasData', hasData)
    if (creating) {
      this.log('creating a new document')
      this.state = initialState
      await this.create()
    } else if (!hasData) {
      this.log(`joining a peer's document for the first time`)
      this.state = {}
      await this.create()
    } else {
      this.log('recovering an existing document from persisted state')
      // TODO: do we need to wait on this?
      await this.rebuildSnapshotsFromHistory()
    }
    this.emit('ready')
    return this.state
  }

  /**
   * Determines whether the repo has previously persisted data or not.
   * @returns `true` if there is any stored data in the repo.
   */
  async hasData() {
    const database = await this.openDB()
    const count = await database.count('feeds')
    return count > 0
  }

  /**
   * Adds a set of changes to the document's append-only history.
   * @param changeSet
   */
  async appendChangeset(changeSet: ChangeSet) {
    const database = await this.openDB()
    await database.add('feeds', changeSet)
    database.close()
  }

  /**
   * Gets all stored changesets from a document's history.
   * @param documentId The ID of the requested document.
   * @returns An array of changesets in order of application.
   */
  private async getChangesets(documentId: string): Promise<ChangeSet[]> {
    const database = await this.openDB()
    const items = await database.getAllFromIndex('feeds', 'documentId', documentId)
    database.close()
    return items
  }

  /**
   * Saves the given object as a snapshot for the given `documentId`, replacing any existing
   * snapshot.
   * @param documentId
   * @param snapshot
   */
  async saveSnapshot(documentId: string, document: any) {
    this.log('saveSnapshot', documentId, document)
    const snapshot = { ...document } // clone without Automerge metadata
    this.state[documentId] = snapshot
    const database = await this.openDB()
    await database.put('snapshots', { documentId, snapshot })
    database.close()
  }

  /**
   * Returns a snapshot of the document's current state.
   * @param documentId
   * @returns
   */
  async getSnapshot(documentId: string) {
    const database = await this.openDB()
    const { snapshot } = await database.get('snapshots', documentId)
    this.log('getSnapshot', documentId, snapshot)
    this.state[documentId] = snapshot
    database.close()
    return snapshot
  }

  /**
   * Removes any existing snapshot for a document, e.g. when the document is marked as deleted.
   * @param documentId
   */
  async removeSnapshot(documentId: string) {
    const database = await this.openDB()
    this.log('deleting', documentId)
    await database.delete('snapshots', documentId)
    database.close()
  }

  /**
   * Gets a list of the IDs of all documents recorded in the repo.
   * @param [objectStore]
   * @returns
   */
  async getDocumentIds(objectStore: string = 'feeds') {
    this.log('getDocumentIds', objectStore)
    const documentIds: string[] = []
    const database = await this.openDB()
    const index = database.transaction(objectStore).store.index('documentId')
    for await (const cursor of index.iterate(undefined, 'nextunique'))
      documentIds.push(cursor.value.documentId)
    this.log('documentIds', documentIds)
    return documentIds.map(documentId => documentId.toString())
  }

  // Private

  /**
   * Opens the local database and returns a reference to it.
   * @returns An `idb` wrapper for an indexed DB.
   */
  private openDB() {
    const storageKey = `cevitxe::${this.databaseName}::${this.discoveryKey.substr(0, 12)}`
    return idb.openDB(storageKey, DB_VERSION, {
      upgrade(db) {
        // feeds
        const feeds = db.createObjectStore('feeds', {
          keyPath: 'id',
          autoIncrement: true,
        })
        feeds.createIndex('documentId', 'documentId')

        // snapshots
        const snapshots = db.createObjectStore('snapshots', {
          keyPath: 'documentId',
          autoIncrement: false,
        })
        snapshots.createIndex('documentId', 'documentId')
      },
    })
  }

  /**
   * Creates a new repo with the given initial state
   * @param initialState
   */
  private async create() {
    for (let documentId in this.state) {
      const document = A.from(this.state[documentId])
      this.setDoc(documentId, document)
    }
  }

  /**
   * Loads all the repo's snapshots into memory
   */
  private async rebuildSnapshotsFromHistory() {
    const documentIds = await this.getDocumentIds('feeds')
    this.log('getting changesets from storage', documentIds)
    for (const documentId of documentIds) this.getDoc(documentId)
  }

  /**
   * Returns all of the repo's document IDs from memory.
   * Note: This does not include deleted documents
   */
  get documentIds() {
    return Object.keys(this.state)
  }

  /**
   * Reconstitutes an Automerge document from its change history
   * @param documentId
   */
  async getDoc(documentId: string) {
    const doc = A.init<T>()
    const changeSets = await this.getChangesets(documentId)
    for (const { changes, isDelete } of changeSets) //
      if (changes) A.applyChanges(doc, changes)
      else if (isDelete) this.removeDoc(documentId)
    return doc
  }

  /**
   * Removes a document from our in-memory state, and deletes its snapshot. (The change history of a
   * document is never deleted, in case it's undeleted at some point.)
   * @param documentId The ID of the document
   */
  removeDoc(documentId: string) {
    delete this.state.documentId
    this.removeSnapshot(documentId)
  }

  /**
   * Saves the document's change history and snapshot, and updates our in-memory state.
   * @param documentId The ID of the document
   * @param doc The new version of the document
   * @param changes (optional) If we're already given the changes (e.g. in `applyChanges`), we can
   * pass them in so we don't have to recalculate them.
   */
  setDoc(documentId: string, doc: A.Doc<T>, changes?: A.Change[]) {
    if (!changes) {
      // look up old doc and generate diff
      const oldDoc = this.getDoc(documentId)
      changes = A.getChanges(A.init(), oldDoc)
    }

    // append changes to this document's history
    this.appendChangeset({ documentId, changes })

    // save snapshot
    this.saveSnapshot(documentId, doc)

    // call handlers
    this.handlers.forEach(handler => handler(documentId, doc))
  }

  /**
   * Updates a document using a set of Automerge changes (typically received from a peer).
   * @param documentId The ID of the document
   * @param changes A diff in the form of an array of Automerge change objects
   * @returns The updated document
   */
  async applyChanges(documentId: string, changes: A.Change[]) {
    // apply changes to document
    let doc = await this.getDoc(documentId)
    doc = A.applyChanges(doc, changes)

    // save the new document
    this.setDoc(documentId, doc, changes)

    // return the modified document
    return doc
  }

  /**
   * Adds a change event listener
   * @param handler
   */
  registerHandler(handler: RepoEventHandler<T>) {
    this.handlers.add(handler)
  }

  /**
   * Removes a change event listener
   */
  unregisterHandler(handler: RepoEventHandler<T>) {
    this.handlers.delete(handler)
  }
}

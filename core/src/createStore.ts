import automerge, { Change, DocSet, Message } from 'automerge'
import * as Redux from 'redux'
import { DeepPartial } from 'redux'
import signalhub from 'signalhub'
import webrtcSwarm from 'webrtc-swarm'
import { Instance as Peer } from 'simple-peer'
import { adaptReducer } from './adaptReducer'
import { automergify } from './automergify'
import { Connection } from './connection'
import { DEFAULT_PEER_HUBS } from './constants'
import debug from './debug'
import { SingleDocSet } from './SingleDocSet'
import { getMiddleware } from './getMiddleware'
import { getKeys } from './keyManager'
import { CreateStoreOptions } from './types'
import hypercore from 'hypercore'
import db from 'random-access-idb'
import { mockCrypto } from './mockCrypto'

const log = debug('cevitxe:createStore')

const valueEncoding = 'utf-8'
const crypto = mockCrypto

export const createStore = async <T>({
  databaseName = 'cevitxe-data',
  peerHubs = DEFAULT_PEER_HUBS,
  proxyReducer,
  defaultState = {}, // If defaultState is not provided, we're joining an existing store
  middlewares = [],
  discoveryKey,
  onReceive,
}: CreateStoreOptions<T>): Promise<Redux.Store> => {
  const { key, secretKey } = getKeys(discoveryKey)
  log('given onReceive', onReceive)
  //const dbName = getDbName(discoveryKey)
  const dbName = `${databaseName}-${discoveryKey.substr(0, 12)}`
  const storage = db(dbName)

  const feed: Feed<string> = hypercore(storage, key, { secretKey, valueEncoding, crypto })
  feed.on('error', (err: any) => console.error(err))

  log('creating feedReady')
  const feedReady = new Promise(yes => feed.on('ready', () => yes()))
  await feedReady
  log('feedReady awaited')

  const hasPersistedData = feed.length > 0
  //console.log('feed ready', feed)

  const state: T | {} = hasPersistedData // is there anything in storage?)
    ? await rehydrateFrom(feed) // if so, rehydrate state from that
    : initialize(feed, defaultState) // if not, initialize

  const connections: Connection<T | {}>[] = []
  const docSet = new SingleDocSet<T | {}>(state)
  log('creating initial docSet', state)

  // Create Redux store
  const reducer = adaptReducer(proxyReducer)
  const enhancer = Redux.applyMiddleware(...middlewares, getMiddleware(feed, docSet))
  const store = Redux.createStore(reducer, state as DeepPartial<DocSet<T>>, enhancer)

  // Now that we've initialized the store, it's safe to subscribe to the feed without worrying about race conditions
  const hub = signalhub(discoveryKey, peerHubs)
  const swarm = webrtcSwarm(hub)

  log('joined swarm', key)
  swarm.on('peer', (peer: Peer, id: any) => {
    //@ts-ignore
    log('peer', peer._id)
    connections.push(new Connection(docSet, peer, store.dispatch, onReceive))
  })

  // const start = feed.length // skip any items we already read when initializing
  // const stream = feed.createReadStream({ start, live: true })
  // // Listen for new items the feed and dispatch them to our redux store
  // stream.on('data', (_data: string) => {
  //   const message = JSON.parse(_data) as Message<T>
  //   // Note: don't confuse `message: {docId, clock, changes}` (generated by automerge.Connection)
  //   // with `change.message: string` (optionally provided to automerge.change())
  //   const changeMessages = (message.changes || []).map((c: Change<T>) => c.message)
  //   log('dispatch from feed', changeMessages)
  // })
  return store
}

const rehydrateFrom = async <T>(feed: Feed<string>): Promise<T> => {
  const batch = new Promise(yes => feed.getBatch(0, feed.length, (_, data) => yes(data)))
  const data = (await batch) as string[]
  const changeSets = data.map(d => JSON.parse(d))
  log('rehydrating from stored change sets', changeSets)
  let state = automerge.init<T>()
  changeSets.forEach(changes => (state = automerge.applyChanges(state, changes)))
  return state
}

const initialize = <T>(feed: Feed<string>, initialState: T): T => {
  log('nothing in storage; initializing')
  const state = automergify(initialState)
  const changeSet = automerge.getChanges(automerge.init(), state)
  feed.append(JSON.stringify(changeSet))
  return state
}

export const joinStore = createStore

export const getDbName = (discoveryKey: string) => `cevitxe-data-${discoveryKey.substr(0, 12)}`
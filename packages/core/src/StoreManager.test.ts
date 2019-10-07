import { newid } from 'cevitxe-signal-client'
import { Server } from 'cevitxe-signal-server'
import debug from 'debug'
import eventPromise from 'p-event'
import { getPortPromise as getAvailablePort } from 'portfinder'
import { StoreManager } from './StoreManager'
import { ProxyReducer } from './types'
import { pause } from './lib/pause'
import { collection } from './collection'

describe('Cevitxe', () => {
  const log = debug('cevitxe:test')
  const teachers = collection('teachers')

  const proxyReducer = ((state, { type, payload }) => {
    const { add, remove, update, drop } = teachers.reducers
    switch (type) {
      case 'ADD_TEACHER':
        return add(payload)
      case 'REMOVE_TEACHER':
        return remove(payload)
      case 'UPDATE_TEACHER':
        return update(payload)
      case 'DROP_TEACHERS':
        return drop()
      default:
        return null
    }
  }) as ProxyReducer

  const teacher1 = { id: 'abcxyz', first: 'Herb', last: 'Caudill' }
  const teacher2 = { id: 'defcba', first: 'Brent', last: 'Keller' }
  const initialState = { foo: { pizza: 1 } }

  const newDiscoveryKey = () => newid(6)

  let server: Server

  afterEach(async () => {
    if (server) await server.close()
  })

  describe('solo', () => {
    const open = async ({ join = false } = {}) => {
      const port = await getAvailablePort({ port: 3000 })
      const urls = [`ws://localhost:${port}`]
      server = new Server({ port })
      await server.listen({ silent: true })

      const discoveryKey = newDiscoveryKey()

      // local StoreManager & store
      const localStoreManager = new StoreManager({
        databaseName: `local-${newid()}`,
        proxyReducer,
        initialState,
        urls,
      })
      const localStore = join
        ? await localStoreManager.joinStore(discoveryKey)
        : await localStoreManager.createStore(discoveryKey)

      // include a teardown function in the return values
      const close = async () => {
        await pause()
        await localStoreManager.close()
      }

      return { close, localStoreManager, localStore, discoveryKey }
    }

    it('should join a store', async () => {
      const { close, localStore } = await open({ join: true })

      // store exists
      expect(localStore).not.toBeUndefined()

      // it looks like a store
      expect(localStore).toHaveProperty('getState')
      expect(localStore).toHaveProperty('dispatch')
      expect(localStore).toHaveProperty('subscribe')

      // it's in empty (waiting) state
      expect(localStore.getState()).toEqual({})

      await close()
      expect.assertions(5)
    })

    it('should create a store', async () => {
      const { close, localStore } = await open()

      // store exists
      expect(localStore).not.toBeUndefined()

      // it looks like a store
      expect(localStore).toHaveProperty('getState')
      expect(localStore).toHaveProperty('dispatch')
      expect(localStore).toHaveProperty('subscribe')

      // it contains the initial state
      expect(localStore.getState()).toEqual(initialState)

      await close()
      expect.assertions(5)
    })

    it('should dispatch a change', async () => {
      const { close, localStoreManager, localStore } = await open()

      // dispatch a change
      localStore.dispatch({ type: 'ADD_TEACHER', payload: teacher1 })

      await eventPromise(localStoreManager, 'change')

      // confirm that the change was made
      const state = localStore.getState()

      const allTeachers = teachers.selectors.getMap(state) as any
      expect(allTeachers.abcxyz.first).toEqual('Herb')

      await close()
      expect.assertions(1)
    })

    it('should close a store', async () => {
      const { close, localStoreManager } = await open()

      // confirm that we have a store
      expect(localStoreManager.store).not.toBeUndefined()

      // close the store
      await close()

      // confirm the store is gone
      expect(localStoreManager.store).toBeUndefined()
      expect.assertions(2)
    })

    it('should persist state between sessions', async () => {
      const { close, localStoreManager, localStore, discoveryKey } = await open()

      // change something in the local store
      localStore.dispatch({ type: 'ADD_TEACHER', payload: [teacher1] })

      // wait for addition to take
      await eventPromise(localStoreManager, 'change')

      // confirm that the changes took locally
      const state0 = localStore.getState()
      expect(teachers.selectors.getMap(state0)).toEqual({ abcxyz: teacher1 })

      // disconnect store
      await localStoreManager.close()

      // Then we join the same store, which should see the state in the fake db and load it
      const localStore1 = await localStoreManager.joinStore(discoveryKey)

      // Confirm that the modified state is still there
      const state1 = localStore1.getState()
      expect(teachers.selectors.getMap(state1)).toEqual({ abcxyz: teacher1 })
      await close()
      expect.assertions(2)
    })

    it('should persist deletions', async () => {
      const { close, localStoreManager, localStore, discoveryKey } = await open()
      localStore.dispatch({ type: 'ADD_TEACHER', payload: [teacher1, teacher2] })

      // wait for both additions to take
      await eventPromise(localStoreManager, 'change')
      await eventPromise(localStoreManager, 'change')

      const state0 = localStore.getState()
      expect(teachers.selectors.getMap(state0)).toEqual({ abcxyz: teacher1, defcba: teacher2 })

      // delete something in the local store
      localStore.dispatch({ type: 'REMOVE_TEACHER', payload: teacher1 })

      // wait for deletion to take
      await eventPromise(localStoreManager, 'change')

      // confirm that the deletion took locally
      const state1 = localStore.getState()
      expect(teachers.selectors.getMap(state1)).toEqual({ defcba: teacher2 })

      // disconnect store
      await localStoreManager.close()

      // Then we create a new store, which should see the state in the fake db and load it
      const state2 = await localStoreManager.joinStore(discoveryKey)

      // Confirm that the modified state is still there
      const newState = state2.getState()
      expect(teachers.selectors.getMap(newState)).toEqual({ defcba: teacher2 })

      await close()
      // expect.assertions(3)
    })
  })

  describe('with a peer', () => {
    const open = async () => {
      const port = await getAvailablePort({ port: 3000 })
      const urls = [`ws://localhost:${port}`]
      server = new Server({ port })
      await server.listen({ silent: true })

      const initialState = {}
      const discoveryKey = newDiscoveryKey()

      // local storemanager & store
      const localStoreManager = new StoreManager({
        databaseName: `local-${newid()}`,
        proxyReducer,
        initialState,
        urls,
      })
      // create new store locally
      const localStore = await localStoreManager.createStore(discoveryKey)

      // remote storemanager & store
      const remoteStoreManager = new StoreManager({
        databaseName: `remote-${newid()}`,
        proxyReducer,
        initialState,
        urls,
      })
      // join store from remote peer
      const remoteStore = await remoteStoreManager.joinStore(discoveryKey)

      // wait for both peers to see connection
      await Promise.all([
        eventPromise(localStoreManager, 'peer'),
        eventPromise(remoteStoreManager, 'peer'),
      ])

      // include a teardown function in the return values
      const close = async () => {
        await pause(500)
        await localStoreManager.close()
        await remoteStoreManager.close()
      }
      return {
        close,
        localStoreManager,
        remoteStoreManager,
        localStore,
        remoteStore,
        discoveryKey,
      }
    }

    it('should sync a new document', async () => {
      const { close, remoteStoreManager, localStore, remoteStore } = await open()

      // change something in the local store
      localStore.dispatch({ type: 'ADD_TEACHER', payload: teacher1 })

      // wait for remote peer to see change
      await eventPromise(remoteStoreManager, 'change')

      const expectedState = { abcxyz: teacher1 }

      // confirm that the change took locally
      const localState = localStore.getState()
      expect(teachers.selectors.getMap(localState)).toEqual(expectedState)

      // confirm that the remote store has the new value
      const remoteState = remoteStore.getState()
      expect(teachers.selectors.getMap(remoteState)).toEqual(expectedState)

      await close()
      expect.assertions(2)
    })

    it('should sync changes to an existing document in both directions', async () => {
      const { close, localStoreManager, remoteStoreManager, localStore, remoteStore } = await open()

      localStore.dispatch({ type: 'ADD_TEACHER', payload: teacher1 })
      await eventPromise(remoteStoreManager, 'change')

      expect(teachers.selectors.getMap(localStore.getState())).toEqual({ abcxyz: teacher1 })

      // modify the teacher in the local store
      localStore.dispatch({
        type: 'UPDATE_TEACHER',
        payload: { id: 'abcxyz', first: 'Herbert' },
      })
      await eventPromise(localStoreManager, 'change')

      // modify the teacher in the remote store
      remoteStore.dispatch({
        type: 'UPDATE_TEACHER',
        payload: { id: 'abcxyz', email: 'h@hc3.me' },
      })
      await eventPromise(remoteStoreManager, 'change')

      await Promise.all([
        eventPromise(remoteStoreManager, 'change'),
        eventPromise(localStoreManager, 'change'),
      ])

      const expectedState = {
        abcxyz: { id: 'abcxyz', first: 'Herbert', last: 'Caudill', email: 'h@hc3.me' },
      }

      // confirm that the local store is caught up
      expect(teachers.selectors.getMap(localStore.getState())).toEqual(expectedState)

      // confirm that the remote store is caught up
      expect(teachers.selectors.getMap(remoteStore.getState())).toEqual(expectedState)

      await close()
      expect.assertions(3)
    })

    it('should sync new documents in both directions', async () => {
      const { close, localStoreManager, remoteStoreManager, localStore, remoteStore } = await open()

      // add a teacher in the local store
      localStore.dispatch({ type: 'ADD_TEACHER', payload: teacher1 })
      await eventPromise(localStoreManager, 'change')

      // add a teacher in the remote store
      remoteStore.dispatch({ type: 'ADD_TEACHER', payload: teacher2 })
      await eventPromise(remoteStoreManager, 'change')

      await Promise.all([
        eventPromise(remoteStoreManager, 'change'),
        eventPromise(localStoreManager, 'change'),
      ])

      const expectedState = {
        abcxyz: { id: 'abcxyz', first: 'Herb', last: 'Caudill' },
        defcba: { id: 'defcba', first: 'Brent', last: 'Keller' },
      }

      // confirm that the local store is caught up
      expect(teachers.selectors.getMap(localStore.getState())).toEqual(expectedState)

      // confirm that the remote store is caught up
      expect(teachers.selectors.getMap(remoteStore.getState())).toEqual(expectedState)

      await close()
      expect.assertions(2)
    })

    it('should persist changes coming from a peer', async () => {
      const {
        close,
        localStoreManager,
        localStore,
        remoteStoreManager,
        remoteStore,
        discoveryKey,
      } = await open()

      // add a teacher in the local store
      localStore.dispatch({ type: 'ADD_TEACHER', payload: teacher1 })
      await eventPromise(localStoreManager, 'change')

      // change something in the local store
      localStore.dispatch({
        type: 'UPDATE_TEACHER',
        payload: { id: 'abcxyz', first: 'Herbert' },
      })
      await eventPromise(localStoreManager, 'change')

      // wait for remote peer to see changes
      await eventPromise(remoteStoreManager, 'change')
      await eventPromise(remoteStoreManager, 'change')

      // confirm that both stores have the new value
      expect(teachers.selectors.getMap(remoteStore.getState()).abcxyz.first).toEqual('Herbert')
      expect(teachers.selectors.getMap(localStore.getState()).abcxyz.first).toEqual('Herbert')

      // disconnect both stores
      await close()

      // create a new store, which should see the state in the db and load it
      const newRemoteStore = await remoteStoreManager.joinStore(discoveryKey)

      // confirm that the modified state is still there
      expect(teachers.selectors.getMap(newRemoteStore.getState()).abcxyz.first).toEqual('Herbert')

      await close()
      expect.assertions(3)
    })

    it('should persist deletions coming from a peer', async () => {
      const {
        close,
        localStoreManager,
        localStore,
        remoteStoreManager,
        remoteStore,
        discoveryKey,
      } = await open()

      // add a record
      localStore.dispatch({ type: 'ADD_TEACHER', payload: teacher1 })
      await eventPromise(localStoreManager, 'change')
      await eventPromise(remoteStoreManager, 'change')

      // confirm that the record is there before deleting it
      expect(teachers.selectors.getMap(localStore.getState())).toHaveProperty('abcxyz')

      // delete a record in the local store
      localStore.dispatch({ type: 'REMOVE_TEACHER', payload: { id: 'abcxyz' } })

      // wait for changes to go through
      await Promise.all([
        eventPromise(remoteStoreManager, 'change'),
        eventPromise(localStoreManager, 'change'),
      ])

      // confirm that the deletion took place locally
      expect(teachers.selectors.getMap(localStore.getState())).not.toHaveProperty('abcxyz')

      // confirm that the deletion took place in the remote store
      expect(teachers.selectors.getMap(remoteStore.getState())).not.toHaveProperty('abcxyz')

      // disconnect both stores
      await close()

      // reconnect remote store
      const newRemoteStore = await remoteStoreManager.joinStore(discoveryKey)

      // Confirm that the deletion was persisted
      expect(teachers.selectors.getMap(newRemoteStore.getState())).not.toHaveProperty('abcxyz')

      await close()
      expect.assertions(4)
    })

    it('should delete any connections', async () => {
      const { close, localStoreManager } = await open()

      // confirm that we have a connection
      expect(Object.keys(localStoreManager.connections)).toHaveLength(1)

      await close()

      // confirm that we no longer have a connection
      expect(Object.keys(localStoreManager.connections)).toHaveLength(0)
      expect.assertions(2)
    })

    it('should sync a dropped collection', async () => {
      const { close, remoteStoreManager, localStore, remoteStore } = await open()

      // add a record
      localStore.dispatch({ type: 'ADD_TEACHER', payload: teacher1 })
      await eventPromise(remoteStoreManager, 'change')

      // confirm that the local store has initial state
      expect(teachers.selectors.count(localStore.getState())).toBe(1)

      // confirm that the remote store has initial state
      expect(teachers.selectors.count(remoteStore.getState())).toBe(1)

      // Drop teachers locally
      localStore.dispatch({ type: 'DROP_TEACHERS' })
      await eventPromise(remoteStoreManager, 'change')

      // confirm that the local store is caught up
      expect(teachers.selectors.count(localStore.getState())).toBe(0)

      // confirm that the remote store is caught up
      expect(teachers.selectors.count(remoteStore.getState())).toBe(0)

      await close()
      expect.assertions(4)
    })
  })
})

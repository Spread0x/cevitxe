import automerge, { DocSet } from 'automerge'
import { ReducerConverter } from './types'
import { feedReducer } from './feedReducer'
import { DOC_ID } from './constants'

// During initialization, we're given a "proxyReducer", which is like a Redux reducer,
// except it's designed to work with automerge objects instead of plain javascript objects.
// Instead of returning a modified state, it returns change functions. Also, when it doesn't
// find a reducer for a given action, it returns`null` instead of the previous state.

// The purpose of this function is to turn a proxyReducer into a real reducer by
// running the proxyReducer's change functions through `automerge.change`.
const convertToReduxReducer: ReducerConverter = proxyReducer => (state, { type, payload }) => {
  const msg = `${type}: ${JSON.stringify(payload)}`
  const fn = proxyReducer({ type, payload })
  if (!fn || !state) return state // no matching function - return the unmodified state
  const doc = state.getDoc(DOC_ID)
  const newDoc = automerge.change(doc, msg, fn) // return a modified Automerge object
  const newState = new DocSet()
  newState.setDoc(DOC_ID, newDoc)
  return newState
}

// This function is used when wiring up the store. It takes a proxyReducer and turns it
// into a real reducer, plus adds our feedReducer to the pipeline.
export const adaptReducer: ReducerConverter = proxyReducer => (state, action) => {
  state = feedReducer(state, action)
  state = convertToReduxReducer(proxyReducer)(state, action)
  return state
}

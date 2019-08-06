import { Cevitxe } from 'cevitxe'
import { JSONSchema7 } from 'json-schema'
import { emptyGrid } from '../ag-grid/emptyGrid'
import { proxyReducer } from './reducers'

export interface State {
  // list: string[]
  // map: { [key: string]: any }
  [key: string]: any
  index: { [key: string]: boolean }
  schema: JSONSchema7
  _testId: string
}

const initialState = () => emptyGrid(3, 3)

const urls = process.env.REACT_APP_SIGNAL_SERVERS
  ? process.env.REACT_APP_SIGNAL_SERVERS.split(',')
  : undefined

export const cevitxe = new Cevitxe({
  databaseName: 'grid',
  proxyReducer,
  initialState,
  urls,
})

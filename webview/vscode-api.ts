import type { HostToWebview, WebviewToHost } from '../src/protocol'

interface VsCodeApi {
  postMessage(message: WebviewToHost): void
  getState(): unknown
  setState(state: unknown): void
}

declare function acquireVsCodeApi(): VsCodeApi

const api: VsCodeApi =
  typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : // Lets the bundle load in a plain browser for UI testing.
      { postMessage: () => {}, getState: () => undefined, setState: () => {} }

export function post(message: WebviewToHost) {
  api.postMessage(message)
}

export function onMessage(handler: (message: HostToWebview) => void): () => void {
  const listener = (e: MessageEvent<HostToWebview>) => handler(e.data)
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}

/** UI preferences persisted per tab; `root` is read back by the panel serializer. */
export interface PersistedState {
  root?: string
  tab?: 'changes' | 'history' | 'prs'
  sidebarWidth?: number
  filesWidth?: number
  split?: boolean
  hideWhitespace?: boolean
  prState?: 'open' | 'closed'
}

export function loadState(): PersistedState {
  return (api.getState() as PersistedState | undefined) ?? {}
}

export function saveState(patch: Partial<PersistedState>) {
  api.setState({ ...loadState(), ...patch })
}

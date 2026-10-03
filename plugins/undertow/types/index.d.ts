// What the undertow mod keeps in $.state for its pane.

/** One action Claude took through undertow, newest last. */
export type LogEntry = {
  id: string
  /** The short description Claude gave the call, or the start of its code. */
  title: string
  app?: string
  status: 'running' | 'done' | 'error' | 'refused'
  /** Local time, HH:MM:SS. */
  at: string
}

/** The pane's latest picture of the app, from lib's snapshot script. */
export type Frame = {
  app: string
  /** Terminal cells for a Raster: columns * rows little-endian u32 triplets, base64. */
  columns: number
  rows: number
  cells: string
  /** The screenshot, small enough to embed in an SVG. */
  image: { mime: string; base64: string }
  width: number
  height: number
  at: string
}

export type ViewStatus =
  | { kind: 'idle' }
  | { kind: 'snapshotting'; app: string }
  | { kind: 'error'; message: string }

declare module 'claude-code' {
  interface PluginState {
    undertow: {
      log: LogEntry[]
      frame: Frame | null
      view: ViewStatus
      stopped: boolean
    }
  }
}

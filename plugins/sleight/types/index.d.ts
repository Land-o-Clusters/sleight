// What the sleight mod keeps in $.state for its pane.

/** The last turn's numbers, as hooks/turn-stats.mjs computes them (copied here: the contract must be self-contained). */
export type TurnCounters = {
  calls: number; reads: number; characters: number; errors: number; pending: number
  omitted: number; unclassified: number; toolMs: number
  text: { docs: number; tree: number; other: number }
  paths: Record<'native' | 'turbo' | 'engine', { actions: number; estimatedActions: number; estimatedCalls: number; actionMs: number; timedActions: number }>
}
export type TurnSummary = {
  durationMs: number | null
  interrupted: boolean
  tokens: Record<'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens', number | null> | null
  costUsd: number | null
  costDeltaUsd: number | null
  stats: TurnCounters | null
}

/** One action Claude took through sleight, newest last. */
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
  /** Terminal cells for a Raster: columns * rows little-endian u32 triplets, base64. Terminal panes only. */
  columns: number
  rows: number
  cells?: string
  /** The screenshot, small enough to embed in an SVG. Other surfaces only. */
  image?: { mime: string; base64: string }
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
    sleight: {
      log: LogEntry[]
      frame: Frame | null
      view: ViewStatus
      stopped: boolean
      replayFile: string
      replaying: boolean
      receipt: { path?: string; review?: string; unavailable?: boolean } | null
      stats: TurnSummary | null
    }
  }
}

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Frame, LogEntry, ViewStatus } from '../types'
import { FRAME_MARKER, snapshotCode } from './snapshot'

// The server's own name in plugin.json; the session lists it as
// plugin:sleight:computer, and its tools as mcp__plugin_sleight_computer__*.
const SERVER = 'computer'
const JS_TOOL = 'mcp__plugin_sleight_computer__js'
const TURN_END_TOOL = 'mcp__plugin_sleight_computer__turn_ended'
const PANE = 'sleight'
const LOG_LIMIT = 200

const log = atom({ plugin: 'sleight', key: 'log' } as const, [] as LogEntry[])
const frame = atom({ plugin: 'sleight', key: 'frame' } as const, null as Frame | null)
const view = atom({ plugin: 'sleight', key: 'view' } as const, { kind: 'idle' } as ViewStatus)
const stopped = atom({ plugin: 'sleight', key: 'stopped' } as const, false)

// Not drawn from, so plain module variables (a reload resets them, harmlessly).
let usedThisTurn = false
let turnRunning = false
let actions = 0
let lastApp: string | undefined
// Set while one of this mod's own calls is in flight, so its tool.call hooks
// let the call through and don't log it.
let ownCall = false
// Apps the pane snapshotted since Claude last used sleight. The engine diffs
// UI state against the latest read of an app, whoever made it, so Claude's
// next diff would be against the pane's read; the next prompt says so.
const snapshottedApps = new Set<string>()
// The pane's last drawn size, for sizing the next snapshot.
let paneColumns = 48
let paneRows = 20

const now = () => new Date().toTimeString().slice(0, 8)

function appFrom(code: string, text: string | undefined): string | undefined {
  return code.match(/getApp\(\s*["'`]([^"'`]+)["'`]/)?.[1] ?? text?.match(/App: ([^.\n]+)\./)?.[1]
}

function setStatus($: { ui: { status: (text: string | undefined) => void } }) {
  $.ui.status(lastApp ? `sleight · ${lastApp} · ${actions} action${actions === 1 ? '' : 's'}` : undefined)
}

// Runs one call on the engine as this mod.
async function call($: any, tool: string, args: Record<string, unknown>) {
  const conn = await $.mcp.connect(SERVER)
  if (!conn.isConnected) throw new Error(conn.message)
  ownCall = true
  try {
    return await $.mcp.call(conn.server, tool, args)
  } finally {
    ownCall = false
  }
}

// Tells the engine the turn is over so it releases what it holds, as Codex
// does at the end of each turn. The relay fills in the session and turn ids.
async function endEngineTurn($: any, event: 'Stop' | 'Interrupt') {
  try {
    const ended = await call($, 'turn_ended', { hook_event_name: event })
    $.ui.log(`sleight: turn_ended ${ended.isError ? `failed: ${JSON.stringify(ended.content)}` : 'sent'}`, { to: 'debug' })
  } catch (err) {
    $.ui.log(`sleight: could not end the turn: ${(err as Error).message}`, { to: 'debug' })
  }
}

async function snapshot($: any, app: string) {
  await update($, view, () => ({ kind: 'snapshotting', app }) as ViewStatus)
  try {
    const result = await call($, 'js', {
      code: snapshotCode(app, Math.max(8, paneColumns - 2), Math.max(4, paneRows - 8)),
      title: 'sleight pane snapshot',
    })
    const text = result.content.map((block: { text?: string }) => block.text ?? '').join('\n')
    const line = text.split('\n').find((l: string) => l.startsWith(FRAME_MARKER))
    if (result.isError || !line) {
      throw new Error(result.isError ? text.slice(0, 200) : 'no frame in the result')
    }
    const shot = JSON.parse(line.slice(FRAME_MARKER.length))
    snapshottedApps.add(app)
    await update($, frame, () => ({ ...shot, at: now() }) as Frame)
    await update($, view, () => ({ kind: 'idle' }) as ViewStatus)
  } catch (err) {
    await update($, view, () => ({ kind: 'error', message: (err as Error).message }) as ViewStatus)
  }
}

async function isPaneOpen($: any): Promise<boolean> {
  const panes = await $.ui.panes()
  return panes.some((pane: { id: string }) => pane.id === PANE)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sleight',
      description: 'Show what sleight is doing in a pane, or `stop` to halt its computer use',
      argumentHint: '[stop]',
      immediate: true,
    })
    return next(e)
  })

  // A new prompt lifts a stop, and tells Claude about pane snapshots that
  // moved the engine's diff baseline.
  on('prompt.submit', async ($, e, next) => {
    await update($, stopped, () => false)
    if (snapshottedApps.size === 0) return next(e)
    const apps = [...snapshottedApps].join(', ')
    snapshottedApps.clear()
    const note =
      `sleight: its pane re-read the UI state of ${apps} after your last sleight call. ` +
      'The engine diffs against the latest read, so pass { disableDiffing: true } to your next ' +
      'getAXState() for that app before relying on a diff.'
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('turn.start', async ($, e, next) => {
    turnRunning = true
    return next(e)
  })

  on('tool.call', { tool: JS_TOOL }, async ($, e, next) => {
    if (ownCall) return next(e)
    if (await read($, stopped)) {
      return { deny: 'The user stopped sleight with /sleight stop. Do not use it again until they ask.' }
    }
    usedThisTurn = true
    snapshottedApps.clear()
    const code = String(e.code ?? '')
    const entry: LogEntry = {
      id: e.tool_use_id,
      title: String(e.title ?? '') || (code.split('\n')[0] ?? '').slice(0, 80),
      status: 'running',
      at: now(),
    }
    await update($, log, list => [...list, entry].slice(-LOG_LIMIT))
    const ran = await next(e)
    const app = appFrom(code, ran.text)
    if (app) lastApp = app
    actions++
    const status: LogEntry['status'] = ran.deny !== undefined ? 'refused' : ran.isError ? 'error' : 'done'
    await update($, log, list => list.map(one => (one.id === entry.id ? { ...one, status, app: app ?? one.app } : one)))
    setStatus($)
    return ran
  })

  // turn_ended stays listed so this mod can call it; Claude may not.
  on('tool.call', { tool: TURN_END_TOOL }, async ($, e, next) =>
    ownCall ? next(e) : { deny: 'turn_ended is internal to sleight; its hooks call it when a turn ends.' },
  )

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    turnRunning = false
    if (!usedThisTurn) return result
    usedThisTurn = false
    // Refresh the pane while the engine turn is still open, then end it.
    if (lastApp && !e.isAborted && (await isPaneOpen($))) await snapshot($, lastApp)
    await endEngineTurn($, e.isAborted ? 'Interrupt' : 'Stop')
    return result
  })

  on('command.run', { command: 'sleight' }, async ($, e) => {
    if (e.args.trim() === 'stop') {
      await update($, stopped, () => true)
      await endEngineTurn($, 'Interrupt')
      $.ui.status('sleight · stopped')
      return { text: 'sleight stopped: Claude can’t use it again until your next message. Press Esc to stop the rest of the turn.' }
    }
    await $.ui.open({ id: PANE, title: 'sleight' })
    return { text: 'sleight pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    paneColumns = Math.max(8, Math.min(120, e.props.bodyColumns ?? 48))
    paneRows = Math.max(10, Math.min(40, Math.floor((e.viewport?.rows ?? 30) / 2)))

    const [entries, shot, status, isStopped] = await Promise.all([read($, log), read($, frame), read($, view), read($, stopped)])

    const picture = (() => {
      if (!shot) return <Text dimColor>No picture yet. It appears after Claude uses an app, or press Refresh.</Text>
      if (e.surface === 'terminal' && 'Raster' in els) {
        const { Raster } = els as any
        return <Raster key="frame" columns={shot.columns} rows={shot.rows} cells={shot.cells} />
      }
      if ('Svg' in els) {
        const { Svg } = els as any
        const w = 320
        const h = Math.round((shot.height / shot.width) * w)
        const source =
          `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
          `<image href="data:${shot.image.mime};base64,${shot.image.base64}" width="${w}" height="${h}"/></svg>`
        return <Svg source={source} alt={`Screenshot of ${shot.app}`} width={w} height={h} />
      }
      return <Text dimColor>{`${shot.app}: picture not shown on this surface.`}</Text>
    })()

    const statusLine =
      status.kind === 'snapshotting' ? `Refreshing ${status.app}…`
      : status.kind === 'error' ? `Couldn't refresh: ${status.message}`
      : shot ? `${shot.app} at ${shot.at}`
      : ''
    const room = Math.max(3, (e.viewport?.rows ?? 30) - (shot?.rows ?? 2) - 8)
    const mark = { running: '…', done: '✓', error: '✗', refused: '⊘' } as const

    return (
      <Box flexDirection="column">
        {picture}
        <Text dimColor>{isStopped ? 'Stopped until your next message.' : statusLine}</Text>
        <Box flexDirection="row">
          <Button
            key="refresh"
            label={turnRunning ? 'Refresh (after this turn)' : 'Refresh'}
            hotkey="r"
            onPress={() => {
              if (turnRunning || !lastApp) return
              const app = lastApp
              void snapshot($, app).then(() => endEngineTurn($, 'Stop'))
            }}
          />
          <Button
            key="stop"
            label="Stop"
            hotkey="s"
            onPress={() => {
              void update($, stopped, () => true)
              void endEngineTurn($, 'Interrupt')
              $.ui.status('sleight · stopped')
            }}
          />
        </Box>
        <Text bold>Actions</Text>
        {entries.length === 0 && <Text dimColor>None yet.</Text>}
        {entries.slice(-room).map(entry => (
          <Text dimColor={entry.status === 'done'} wrap="truncate-end">
            {`${mark[entry.status]} ${entry.at} ${entry.app ? `${entry.app}: ` : ''}${entry.title}`}
          </Text>
        ))}
      </Box>
    )
  })
}

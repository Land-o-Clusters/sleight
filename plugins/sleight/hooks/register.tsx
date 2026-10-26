import { createNarrationCache } from './narration.mjs'
import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { Frame, LogEntry, ViewStatus } from '../types'
import { FRAME_MARKER, snapshotCode } from './snapshot'
import { fileArgument, outcomeOf, resultEntries } from './replay'
import type { ReplayScript } from './replay'
import { preapprovedWriteTarget, preapprovedWriteReason, loggingSwitchWriteDenied } from './preapproved-write-guard.mjs'
import { shellLaunchDenied, shellGuardReason } from './shell-guard.mjs'
import { costSnapshot, statsFromReply, turnSummary, turnStatsText } from './turn-stats.mjs'
import type { TurnSummary } from './turn-stats.mjs'

// The server's own name in plugin.json; the session lists it as
// plugin:sleight:computer, and its tools as mcp__plugin_sleight_computer__*.
const SERVER = 'computer'
const JS_TOOL = 'mcp__plugin_sleight_computer__js'
const TURN_END_TOOL = 'mcp__plugin_sleight_computer__turn_ended'
const REPLAY_TOOL = 'mcp__plugin_sleight_computer__replay'
const BROWSER_TOOLS = ['browser_open', 'browser_read', 'browser_act', 'browser_fill']
const PANE = 'sleight'
const LOG_LIMIT = 200

const log = atom({ plugin: 'sleight', key: 'log' } as const, [] as LogEntry[])
const frame = atom({ plugin: 'sleight', key: 'frame' } as const, null as Frame | null)
const view = atom({ plugin: 'sleight', key: 'view' } as const, { kind: 'idle' } as ViewStatus)
const stopped = atom({ plugin: 'sleight', key: 'stopped' } as const, false)
const replayFile = atom({ plugin: 'sleight', key: 'replayFile' } as const, '')
const replaying = atom({ plugin: 'sleight', key: 'replaying' } as const, false)
let replayActive = false
let replayCancelled = false
let replaySequence = 0
const receipt = atom({ plugin: 'sleight', key: 'receipt' } as const, null as { path?: string; review?: string; unavailable?: boolean } | null)
const stats = atom({ plugin: 'sleight', key: 'stats' } as const, null as TurnSummary | null)
type StatsTurn = { id: string; used: boolean; forwarded: number; baseline?: Awaited<ReturnType<typeof hostCost>>; stoppedStats: ReturnType<typeof statsFromReply>; stopping?: Promise<string | undefined> }
let statsTurn: StatsTurn | undefined
let latestStatsOwner: StatsTurn | undefined
async function hostCost($: any) {
  try { return costSnapshot(await $.session.usage()) } catch { return null }
}

async function storeStats($: any, summary: TurnSummary, owner?: StatsTurn) {
  await update($, stats, () => { latestStatsOwner = owner; return summary })
}

// Not drawn from, so plain module variables (a reload resets them, harmlessly).
let usedThisTurn = false
// A genuine turbo prompt needs an end fence even if no sleight tool runs.
// Binding that prompt alone must not activate the shell guard.
let turboTurnBound = false
let remoteTurnBound = false
let turnRunning = false
let actions = 0
let lastApp: string | undefined
// The exact snapshot code in flight, for the tool.check below.
let snapshotInFlight: string | undefined
// Apps the pane snapshotted since Claude last used sleight. The engine diffs
// UI state against the latest read of an app, whoever made it, so Claude's
// next diff would be against the pane's read; the next prompt says so.
const snapshottedApps = new Set<string>()
// The pane's last drawn size, for sizing the next snapshot.
let paneColumns = 48
let paneRows = 20
// The surface that last drew the pane; a snapshot carries only what it draws.
let paneSurface = 'terminal'

// Host-issued turn capability stays in this mod's private runtime. It never
// enters atoms, pane history, prompt context or model-facing tool results.
type TurboEnvelope = { version: 1; session: string; nonce: string }
let turboEnvelope: TurboEnvelope | undefined
let turboSequence = 0
let turboPending = Promise.resolve()

async function beginTurboTurn($: Pick<EngineInterface, 'process' | 'plugin'>, text: string, origin: 'composer' | 'bridge'): Promise<string | undefined> {
  if (turboSequence >= Number.MAX_SAFE_INTEGER) return
  const turn = `turbo-${++turboSequence}`
  let context: string | undefined
  const running = turboPending.then(async () => {
    try {
      let enabled = false
      let present = origin !== 'bridge'
      try {
        const state = await $.process.run([`${$.plugin.root}/bin/sleight-mcp`, 'turbo-state'])
        if (state.exitCode === 0 && state.isStdoutTruncated !== true && typeof state.stdout === 'string' && state.stdout.length <= 4096) {
          const data = JSON.parse(state.stdout)
          narration.configure(data?.narration)
          enabled = data?.enabled === true
          const p = data?.presence
          if (origin !== 'bridge' && typeof p?.locked === 'boolean' && Number.isFinite(p.idleSeconds) && p.idleSeconds >= 0)
            present = !p.locked && p.idleSeconds < 120
        } else { narration.configure('off') }
      } catch { narration.configure('off') /* User text still reaches the relay when turbo is unavailable. */ }
      if (!enabled && present && !/^[ \t]*allow\b/i.test(text)) return
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!turboEnvelope) {
          const response = await call($, 'turn_ended', { sleight_turbo: { event: 'bootstrap' } })
          if (response.isError || response.content?.length !== 1 || response.content[0]?.type !== 'text' ||
              typeof response.content[0].text !== 'string' || response.content[0].text.length > 4096) return
          const data = JSON.parse(response.content[0].text)
          const envelope = data?.sleightTurbo
          if (!data || Object.keys(data).length !== 1 || !envelope || Object.keys(envelope).length !== 3 || envelope.version !== 1 ||
              typeof envelope.session !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(envelope.session) ||
              typeof envelope.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.nonce)) return
          turboEnvelope = { version: 1, session: envelope.session, nonce: envelope.nonce }
        }
        let response
        try { response = await call($, 'turn_ended', { sleight_turbo: { ...turboEnvelope, event: 'begin', turn, text, origin, turbo: enabled } }) }
        catch { turboEnvelope = undefined; continue }
        if (response.isError) { turboEnvelope = undefined; continue }
        if (origin === 'bridge') remoteTurnBound = true
        try {
          const remote = JSON.parse(response.content?.[0]?.text ?? '')?.sleightRemote
          if (remote?.turboBound === true) turboTurnBound = true
          if (typeof remote?.context === 'string' && remote.context.length <= 4096 &&
              /^sleight: Ask the user to reply: allow [^\r\n]+$/.test(remote.context)) context = remote.context
        } catch { /* A missing context line changes no authority. */ }
        break
      }
    } catch { turboEnvelope = undefined }
  })
  turboPending = running
  await running
  return context
}

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
  return $.mcp.call(conn.server, tool, args)
}

async function recordCurrent($: any, file?: string) {
  if (turnRunning || replayActive) return { text: 'Wait for the current run to finish before recording.' }
  try {
    const path = file !== undefined ? fileArgument(file) : `sleight-${await $.session.id()}.json`
    if (await $.fs.exists(path)) throw new Error(`${path} already exists. Choose another file.`)
    const session = await $.session.id()
    // The live API's messages may have been compacted. The CLI reads the saved transcript.
    // Write to a sidecar so a script over the host's 4 MiB stdout cap still records.
    const staging = `${path}.recording`
    let recorded
    try {
      const run = await $.process.run([`${$.plugin.root}/bin/sleight-mcp`, 'record', session, staging])
      if (run.exitCode !== 0) throw new Error(run.stderr || `Recorder exited ${run.exitCode}.`)
      recorded = JSON.parse(await $.fs.read(staging))
    } finally {
      try { await $.process.run(['/bin/rm', '-f', staging]) } catch {}
    }
    if (!recorded.steps?.length) throw new Error('No successful sleight actions in this session yet.')
    await $.fs.write(path, JSON.stringify(recorded, null, 2) + '\n')
    await update($, replayFile, () => path)
    return { text: `Recorded ${recorded.steps.length} steps to ${path}.${recorded.skipped?.length ? ` Skipped tools: ${[...new Set(recorded.skipped)].join(', ')}.` : ''}` }
  } catch (err) {
    return { text: `Recording failed: ${(err as Error).message}` }
  }
}

async function replayCurrent($: any, file: string) {
  if (turnRunning || replayActive) return { text: 'Wait for the current run to finish before replaying.' }
  replayActive = true
  replayCancelled = false
  const id = `replay-${++replaySequence}`
  let engineStarted = false
  let handoff: string | undefined
  try {
    if (await read($, stopped) || replayCancelled) return { text: 'sleight is stopped. Send a new message before replaying.' }
    const path = fileArgument(file)
    const script: ReplayScript = JSON.parse(await $.fs.read(path))
    if (replayCancelled) return { text: 'Replay stopped before starting.' }
    if (script?.sleightReplay !== 1 || !Array.isArray(script.steps)) throw new Error('Not a sleight replay script.')
    await update($, replayFile, () => path)
    await update($, replaying, () => true)
    snapshottedApps.clear()
    await update($, log, list => [...list, { id, title: `Replaying ${path}`, status: 'running', at: now() } as LogEntry].slice(-LOG_LIMIT))
    const conn = await $.mcp.connect(SERVER)
    if (!conn.isConnected) throw new Error(conn.message)
    if (await read($, stopped) || replayCancelled) {
      await update($, log, list => list.map(entry => entry.id === id ? { ...entry, title: 'Replay stopped before starting.', status: 'refused' } : entry))
      return { text: 'Replay stopped before starting.' }
    }
    engineStarted = true
    const outcome = outcomeOf(await $.mcp.call(conn.server, 'replay', { script }))
    // The replay's reads move the engine's diff baseline, as a pane snapshot does.
    // Literal getApp("Name") is enough; otherwise the App: line in the outcome window.
    const windowText = typeof outcome.window === 'string' ? outcome.window : undefined
    for (const step of script.steps) {
      const app = appFrom(step.args?.code ?? '', windowText)
      if (app) snapshottedApps.add(app)
    }
    const entries = resultEntries(script, outcome, id, now())
    await update($, log, list => [...list.filter(entry => entry.id !== id), ...entries].slice(-LOG_LIMIT))
    if (await read($, stopped) || replayCancelled) {
      const step = outcome.step ?? outcome.steps ?? outcome.waits.at(-1)?.step
      const text = `Replay stopped by the user at step ${step ?? 'unknown'}. This step may have sent input. Check the window before repeating it.`
      await update($, log, list => [...list, { id: `${id}-stop`, title: text, status: 'refused', at: now() } as LogEntry].slice(-LOG_LIMIT))
      return { text }
    }
    if (!outcome.ok) {
      // No pane read or turn_ended here: either can discard a pending flow exception.
      handoff = 'sleight replay stopped. Inspect the stop details and finish the task with the existing app handles. ' +
        'The stopped batch may have sent input; check the window before repeating any action. ' +
        'Respect refusals and ask the user for any required approval. Replay result:\n' + JSON.stringify(outcome)
      return { text: `Replay stopped at step ${outcome.step}: ${outcome.error}. Sending the stop details to Claude.` }
    }
    const app = [...script.steps].reverse().map(step => appFrom(step.args.code ?? '', windowText)).find(Boolean)
    if (app) lastApp = app
    actions += outcome.steps ?? 0
    setStatus($)
    await endEngineTurn($, 'Stop')
    return { text: `Replay finished: ${outcome.steps} steps.` }
  } catch (err) {
    const message = (err as Error).message
    await update($, log, list => [...list.filter(entry => entry.id !== id), { id, title: `Replay failed: ${message}`, status: 'error', at: now() } as LogEntry].slice(-LOG_LIMIT))
    if (engineStarted) await endEngineTurn($, 'Interrupt')
    return { text: `Replay failed: ${message}` }
  } finally {
    if (replayCancelled) await update($, stopped, () => true)
    await update($, replaying, () => false)
    replayActive = false
    if (handoff) {
      const prompt = handoff
      $.clock.after(0, async () => {
        if (await read($, stopped) || replayCancelled) return
        if (replayActive || id !== `replay-${replaySequence}`) {
          $.ui.toast('sleight: a newer replay started before the stop reached Claude. Send the stop details from the log when it finishes.')
          return
        }
        await $.prompt.submit({ text: prompt }).catch((err: Error) => $.ui.toast(`sleight: couldn't hand the stop to Claude (${err.message}). Send the stop details from the log.`))
      })
    }
  }
}

// Tells the engine the turn is over so it releases what it holds, as Codex
// does at the end of each turn. The relay fills in the session and turn ids.
async function endEngineTurn($: any, event: 'Stop' | 'Interrupt', checked = false, completed?: TurnSummary, owner?: StatsTurn) {
  try {
    const ended = await call($, 'turn_ended', { hook_event_name: event, ...(checked ? { sleight_stop: true } : {}), ...(owner?.used && (completed || checked) ? { sleight_stats: owner.id } : {}) })
    if (checked && owner) owner.stoppedStats = statsFromReply(ended)
    if (completed) await storeStats($, { ...completed, stats: statsFromReply(ended) }, owner)
    let latest = (ended as { _meta?: { 'sleight/receipt'?: { path?: string; review?: string; unavailable?: boolean } } })._meta?.['sleight/receipt']
    // The installed host's $.mcp.call keeps content but drops _meta. The relay supplies JSON
    // in one fixed marker so paths with spaces and multi-line reviews don't need a prose parser.
    if (!latest) for (const block of ended.content ?? []) {
      const text = block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
      if (!text.startsWith('sleight-receipt: ') || text.length > 262144) continue
      try {
        const value = JSON.parse(text.slice('sleight-receipt: '.length))
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        latest = {
          ...(typeof value.path === 'string' && value.path.startsWith('/') && value.path.length <= 4096 ? { path: value.path } : {}),
          ...(typeof value.review === 'string' && value.review.length <= 32100 ? { review: value.review } : {}),
          ...(value.unavailable === true ? { unavailable: true } : {}),
        }
      } catch {}
    }
    if (latest) await update($, receipt, () => latest)
    $.ui.log(`sleight: turn_ended ${ended.isError ? `failed: ${JSON.stringify(ended.content)}` : 'sent'}`, { to: 'debug' })
    // The relay names an app sleight drove that holds a keyboard event tap, once per session.
    for (const block of ended.content ?? []) {
      const text = typeof block?.text === 'string' ? block.text : ''
      if (text.startsWith('sleight-warning: ')) $.ui.toast(text.slice('sleight-warning: '.length))
    }
    if (checked) {
      return (ended.content ?? []).map((block: { text?: string }) => block.text ?? '')
        .find((text: string) => text.startsWith('sleight stop:')) ?? 'sleight stop unconfirmed: the engine returned no checked receipt.'
    }
  } catch (err) {
    if (completed) await storeStats($, completed, owner)
    $.ui.log(`sleight: could not end the turn: ${(err as Error).message}`, { to: 'debug' })
    if (checked) return `sleight stop unconfirmed: ${(err as Error).message}`
  }
}

function stopEngineTurn($: any) {
  const owner = statsTurn
  if (owner) owner.stoppedStats = null
  const pending = endEngineTurn($, 'Interrupt', true, undefined, owner)
  if (owner) owner.stopping = pending
  return pending
}

async function snapshot($: any, app: string) {
  await update($, view, () => ({ kind: 'snapshotting', app }) as ViewStatus)
  try {
    // Leave rows for the status, controls, file input, "Actions" and three log lines.
    const code = snapshotCode(app, Math.max(8, paneColumns - 2), Math.max(4, paneRows - 9), paneSurface === 'terminal')
    snapshotInFlight = code
    const result = await call($, 'js', { code, title: 'sleight pane snapshot', sleight_stats: { internal: true } }).finally(() => { snapshotInFlight = undefined })
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

// A pane list that rejects counts as closed: the turn's end runs after this check, and an engine
// turn that never ends keeps the session busy.
async function isPaneOpen($: any): Promise<boolean> {
  try {
    const panes = await $.ui.panes()
    return panes.some((pane: { id: string }) => pane.id === PANE)
  } catch {
    return false
  }
}

// In Auto mode the classifier refused the pane's own snapshot, since no request of the person's
// asked for it (2026-10-08). This mod allows exactly two calls: its snapshot, by the code it just
// built, and turn_ended. next.origin is set by the host, so only this plugin's own calls pass;
// Claude's calls (origin engine) go to the normal check.
function ownCallVerdict(e: { tool: string; input: unknown }, origin: { plugin: string } | undefined) {
  if (origin?.plugin !== 'sleight') return undefined
  if (e.tool === TURN_END_TOOL) return { decision: 'allow', reason: 'sleight ends the engine turn' } as const
  const code = (e.input as { code?: unknown } | undefined)?.code
  if (e.tool === JS_TOOL && snapshotInFlight !== undefined && code === snapshotInFlight) {
    return { decision: 'allow', reason: 'sleight pane snapshot' } as const
  }
  return undefined
}

const narration = createNarrationCache()
// The existing genuine-prompt turbo-state reply includes narration mode. No extra process,
// file read, transcript request or awaited work is added to a tool call.
function narrated<T extends { tool_use_id?: string; agentId?: string }>(event: T) {
  return { ...event, sleight_say: narration.take(event) ?? '' }
}

export const register: Register = on => {
  on('session.append', ($, e, next) => { narration.observe(e); return next(e) })
  on('session.compact', ($, e, next) => { narration.reset(); return next(e) })

  on('classic.PreToolUse', async ($, e, next) => {
    if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'].includes(e.tool)) return next(e)
    if (usedThisTurn && shellLaunchDenied(e) && await $.env.get('SLEIGHT_SHELL_GUARD') !== '0') return { deny: shellGuardReason }
    if (loggingSwitchWriteDenied(e)) return { deny: "Only the user turns on sleight's action log and outcome lines. Ask them to make this change." }
    const denied = await preapprovedWriteTarget(e, {
      stat: (path: string) => $.fs.stat(path, { resolve: true }),
      home: await $.env.get('HOME'),
      configDir: await $.env.get('CLAUDE_CONFIG_DIR'),
    })
    return denied ? { deny: preapprovedWriteReason(denied) } : next(e)
  })
  on('tool.check', async ($, e, next) => ownCallVerdict(e, next.origin) ?? next(e))
    // Failing open to the normal check only ever tightens. A call from inside this mod's own
    // frame lands here as a re-entry, decided from e and next alone. The host's published
    // HookFailure kind union is 'throw' | 'timeout' only, so the kind reads through a widening.
    .catch(($, e, next) => ((next.error?.kind as string | undefined) === 're-entry' ? ownCallVerdict(e, next.origin) : undefined) ?? next(e))
  on('session.start', async ($, e, next) => {
    turboEnvelope = undefined
    remoteTurnBound = false
    narration.configure('off')
    await $.command.register({
      name: 'sleight',
      description: 'Open the sleight pane; show turn stats, replay, record, or stop computer use',
      argumentHint: '[stats | replay <file> | record [file] | stop | prompt]',
      immediate: true,
    })
    return next(e)
  })

  // A new prompt lifts a stop, and tells Claude about pane snapshots that
  // moved the engine's diff baseline. The host skips this hook for our own
  // automatic handoff, so that handoff cannot lift Stop.
  on('prompt.submit', async ($, e, next) => {
    if (await read($, stopped)) {
      // A failed collection keeps the relay alive. Lift its closing flag only at this user boundary.
      await call($, 'turn_ended', { sleight_resume: true }).catch(() => undefined)
    }
    await update($, stopped, () => false)
    const approvalNote = (e.origin?.kind === 'composer' || e.origin?.kind === 'bridge') &&
        (e as { agentId?: string }).agentId === undefined ? await beginTurboTurn($, e.text, e.origin.kind) : undefined
    if (approvalNote) e = { ...e, context: [...(e.context ?? []), approvalNote] }
    if (snapshottedApps.size === 0) return next(e)
    const apps = [...snapshottedApps].join(', ')
    snapshottedApps.clear()
    const note =
      `sleight: its pane or a replay read the UI state of ${apps} after your last sleight call. ` +
      'The engine diffs against the latest read, so pass { disableDiffing: true } to your next ' +
      'getAXState() for that app before relying on a diff.'
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('turn.start', async ($, e, next) => {
    turnRunning = true
    // Older host captures omit agentId from turn.start's type, as with prompt.submit above.
    if ((e as { agentId?: string }).agentId !== undefined) return next(e)
    const owner: StatsTurn = { id: e.turnId, used: false, forwarded: 0, stoppedStats: null }
    statsTurn = owner
    // Never hold up a turn for the ledger, including turns that never use sleight.
    // Capture the owner so an older read cannot overwrite a newer turn's baseline.
    void hostCost($).then(cost => { owner.baseline = cost })
    return next(e)
  })

  // A private argument, removed by the relay before forwarding. Subagents are outside
  // these main-loop counters, even when an old child calls during a later turn.
  const counted = <T extends { agentId?: string; sleight_say?: string }>(e: T, owner: StatsTurn | undefined) => {
    const sleight_say = e.sleight_say
    const event = { ...e }; delete event.sleight_say
    const say = sleight_say ? { say: sleight_say } : {}
    if (e.agentId !== undefined || !owner) return { ...event, sleight_stats: { internal: true, ...say } }
    return { ...event, sleight_stats: { turn: owner.id, ...say } }
  }

  const forward = async <T extends { agentId?: string }, R>(e: T, owner: StatsTurn | undefined, next: (event: T) => Promise<R>) => {
    const main = e.agentId === undefined ? owner : undefined
    // A call may be interrupted before next returns. Stop must collect it already.
    if (main) { main.forwarded++; main.used = true }
    const ran = await next(counted(e, owner))
    // An explicit denial did not reach the engine. Other pending or completed calls
    // still own stats; thrown calls may have sent input and retain their counters.
    if (main && (ran as { deny?: unknown }).deny !== undefined) main.used = --main.forwarded > 0
    return ran
  }

  on('tool.call', { tool: JS_TOOL }, async ($, e, next) => {
    const owner = statsTurn
    if (next.origin?.plugin === 'sleight') return next(e)
    if (replayActive) return { deny: 'A replay is running. Wait for it to stop before sending another tool call.' }
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
    const ran = await forward(narrated(e), owner, next)
    const app = appFrom(code, ran.text)
    if (app) lastApp = app
    actions++
    const status: LogEntry['status'] = ran.deny !== undefined ? 'refused' : ran.isError ? 'error' : 'done'
    await update($, log, list => list.map(one => (one.id === entry.id ? { ...one, status, app: app ?? one.app } : one)))
    setStatus($)
    return ran
  })

  // The host's tool-name union comes from its last saved capture, which here
  // predates the replay tool, so the filter's name reads through a widening.
  on('tool.call', { tool: REPLAY_TOOL as never }, async ($, e, next) => {
    const owner = statsTurn
    if (next.origin?.plugin === 'sleight') return next(e)
    if (await read($, stopped)) return { deny: 'The user stopped sleight with /sleight stop. Do not use it again until they ask.' }
    if (replayActive) return { deny: 'A replay is running. Wait for it to stop before sending another tool call.' }
    usedThisTurn = true
    return forward(narrated(e), owner, next)
  })

  // Compact browser verbs are session work too. The fixed completion hook must
  // fence turbo even when the turn never called native JS. Log only the verb,
  // keeping field values and page content out of the pane's action history.
  for (const name of BROWSER_TOOLS) on('tool.call', { tool: `mcp__plugin_sleight_computer__${name}` as never }, async ($, e, next) => {
    const owner = statsTurn
    if (next.origin?.plugin === 'sleight') return next(e)
    if (await read($, stopped)) return { deny: 'The user stopped sleight with /sleight stop. Do not use it again until they ask.' }
    if (replayActive) return { deny: 'A replay is running. Wait for it to stop before sending another tool call.' }
    usedThisTurn = true
    const entry: LogEntry = { id: (e as { tool_use_id: string }).tool_use_id, title: name, status: 'running', at: now() }
    await update($, log, list => [...list, entry].slice(-LOG_LIMIT))
    const ran = await forward(narrated(e), owner, next)
    actions++
    const status: LogEntry['status'] = ran.deny !== undefined ? 'refused' : ran.isError ? 'error' : 'done'
    await update($, log, list => list.map(one => one.id === entry.id ? { ...one, status } : one))
    setStatus($)
    return ran
  })

  // turn_ended stays listed so this mod can call it; Claude may not.
  on('tool.call', { tool: TURN_END_TOOL }, async ($, e, next) =>
    next.origin?.plugin === 'sleight' ? next(e) : { deny: 'turn_ended is internal to sleight; its hooks call it when a turn ends.' },
  )

  on('turn.complete', async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      if (e.agentId === undefined) {
        turnRunning = false
        // Stats ownership cannot gate engine cleanup, including mid-turn mod loads.
        const needsEnd = usedThisTurn || turboTurnBound || remoteTurnBound
        usedThisTurn = false
        turboTurnBound = false
        remoteTurnBound = false
        const owner = statsTurn?.id === e.turnId ? statsTurn : undefined
        if (owner) statsTurn = undefined
        if (needsEnd || owner?.used) {
          const baseline = owner?.baseline
          const completed = owner?.used ? turnSummary(e, null) : undefined
          if (!needsEnd) {
            await owner?.stopping
            if (completed) await storeStats($, { ...completed, stats: owner?.stoppedStats ?? null }, owner)
          } else {
            // Refresh the pane while the engine turn is still open, then end it.
            if (lastApp && !e.isAborted && (await isPaneOpen($))) await snapshot($, lastApp)
            await endEngineTurn($, e.isAborted ? 'Interrupt' : 'Stop', false, completed, owner)
          }
          // Usage is optional and can hang. Cleanup and the summary never wait for it.
          if (completed && owner) {
            void hostCost($).then(async cost => {
              if (!cost) return
              const final = turnSummary(e, cost, baseline)
              await update($, stats, latest => latest && latestStatsOwner === owner
                ? { ...latest, costUsd: final.costUsd, costDeltaUsd: final.costDeltaUsd } : latest)
            }).catch(() => undefined)
          }
        }
      }
    }
  })

  on('command.run', { command: 'sleight' }, async ($, e) => {
    const args = e.args.trim()
    if (args === 'stats') return { text: turnStatsText(await read($, stats)) }
    if (args === 'record' || args.startsWith('record ')) return recordCurrent($, args.slice(6).trim() || undefined)
    if (e.args.trim() === 'stop') {
      if (replayActive) replayCancelled = true
      await update($, stopped, () => true)
      usedThisTurn = false
      turboTurnBound = false
      remoteTurnBound = false
      const receipt = await stopEngineTurn($)
      $.ui.status('sleight · stopped')
      // The interrupted call usually ends Claude's turn at once (desktop app, 2026-10-11), so Esc
      // is only for a turn that goes on without sleight.
      return { text: `${receipt} If Claude keeps working, press Esc to end its turn.` }
    }
    await $.ui.open({ id: PANE, title: 'sleight' })
    if (args === 'replay' || args.startsWith('replay ')) return replayCurrent($, args.slice(6))
    // `/sleight do this` opens the pane and sends "do this" to Claude, as if
    // typed on its own line. The engine refuses a submit from inside this hook
    // (the prompt would wait on the command submitting it), so it goes out
    // just after; it waits for any running turn to finish.
    const prompt = e.args.trim()
    if (!prompt) return { text: 'sleight pane opened.' }
    $.clock.after(0, async () => {
      // A new session may not have connected sleight yet. Sent first, the prompt ran with no
      // sleight tools and Claude used the shell instead (2026-10-08).
      await $.mcp.connect(SERVER).catch(() => undefined)
      $.prompt.submit({ text: prompt, asUser: true }).catch(err => {
        $.ui.toast(`sleight: couldn't send your prompt (${(err as Error).message}). Send it on its own line.`)
      })
    })
    return { text: 'sleight pane opened. Sending your prompt to Claude.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    paneSurface = e.surface
    paneColumns = Math.max(8, Math.min(120, e.props.bodyColumns ?? 48))
    // The rows the surface gave the pane: about a third of the terminal inline,
    // its full height docked. A picture sized to more pushes the buttons and
    // log out of view.
    paneRows = Math.max(10, Math.min(40, e.props.scroll?.bodyRows ?? Math.floor((e.viewport?.rows ?? 30) / 2)))

    const [entries, shot, status, isStopped, file, isReplaying, latest, latestStats] = await Promise.all([read($, log), read($, frame), read($, view), read($, stopped), read($, replayFile), read($, replaying), read($, receipt), read($, stats)])

    const picture = (() => {
      if (!shot) return <Text dimColor>No picture yet. It appears after Claude uses an app, or press Refresh.</Text>
      if (e.surface === 'terminal' && 'Raster' in els && shot.cells) {
        const { Raster } = els as any
        return <Raster key="frame" columns={shot.columns} rows={shot.rows} cells={shot.cells} />
      }
      if ('Svg' in els && shot.image) {
        const { Svg } = els as any
        // Not `h`: JSX compiles to calls of the global h, and a local h broke the drawing.
        const width = 320
        const height = Math.round((shot.height / shot.width) * width)
        const source =
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
          `<image href="data:${shot.image.mime};base64,${shot.image.base64}" width="${width}" height="${height}"/></svg>`
        return <Svg source={source} alt={`Screenshot of ${shot.app}`} width={width} height={height} />
      }
      return <Text dimColor>{`${shot.app}: picture not shown on this surface. Press Refresh.`}</Text>
    })()

    const statusLine =
      isReplaying ? 'Replay running. Stop ends it after the current call.'
      : status.kind === 'snapshotting' ? `Refreshing ${status.app}…`
      : status.kind === 'error' ? `Couldn't refresh: ${status.message}`
      : shot ? `${shot.app} at ${shot.at}`
      : ''
    // Size the log to the rows the pane shows, not the whole terminal: picture,
    // status line, buttons and the "Actions" heading take the rest.
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 30
    const room = Math.max(3, bodyRows - (shot?.rows ?? 1) - 6)
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
              if (turnRunning || replayActive || !lastApp) return
              const app = lastApp
              void snapshot($, app).then(() => endEngineTurn($, 'Stop'))
            }}
          />
          <Button
            key="stop"
            label="Stop"
            hotkey="s"
            onPress={() => {
              if (replayActive) replayCancelled = true
              void update($, stopped, () => true)
              usedThisTurn = false
              void stopEngineTurn($).then(receipt => $.ui.toast(receipt ?? 'sleight stop unconfirmed'))
              $.ui.status('sleight · stopped')
            }}
          />
        </Box>
        {'Input' in els && (() => {
          const { Input } = els as any
          return <Input key="replay-file" value={file} placeholder="Replay JSON file" onInput={(value: string) => update($, replayFile, () => value)} onSubmit={(value: string) => update($, replayFile, () => value)} />
        })()}
        <Box flexDirection="row">
          <Button key="replay" label="Replay file" onPress={async () => {
            const result = await replayCurrent($, await read($, replayFile))
            $.ui.toast(result.text)
          }} />
          <Button key="record" label="Record session" onPress={async () => {
            const result = await recordCurrent($, await read($, replayFile))
            $.ui.toast(result.text)
          }} />
        </Box>
        {/* Text, not a Link: Claude Code 2.1.288 refuses a file:// href and then draws nothing (CI, 2026-10-11). */}
        {latest?.path?.startsWith('/') && <Text>Latest receipt: {latest.path}</Text>}
        {latest?.unavailable && <Text>Receipt unavailable; the private file could not be written.</Text>}
        {latest?.review && <Text>{latest.review}</Text>}
        {latestStats && <Text>{turnStatsText(latestStats)}</Text>}
        <Text bold>Actions</Text>
        {entries.length === 0 && <Text dimColor>None yet.</Text>}
        {/* Newest first, so the latest action stays visible however short the pane is. */}
        {entries.slice(-room).reverse().map(entry => (
          <Text dimColor={entry.status === 'done'} wrap="truncate-end">
            {`${mark[entry.status]} ${entry.at} ${entry.app ? `${entry.app}: ` : ''}${entry.title}`}
          </Text>
        ))}
      </Box>
    )
  })
}

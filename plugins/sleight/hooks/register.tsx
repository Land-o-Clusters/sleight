import { createNarrationCache } from './narration.mjs'
import { stopRecovery, stopRefusal } from './stop-notice.mjs'
import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { Frame, LogEntry, ViewStatus } from '../types'
import { FRAME_MARKER, snapshotCode } from './snapshot'
import { fileArgument, outcomeOf, resultEntries } from './replay'
import type { ReplayScript } from './replay'
import { preapprovedWriteTarget, preapprovedWriteReason, loggingSwitchWriteDenied, guardUnavailableReason } from './preapproved-write-guard.mjs'
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
const APP_TOOLS = ['drag', 'hover', 'open_file', 'menu_bar', 'select_window', 'notifications', 'app_handoff', 'browser_tabs']
const PANE = 'sleight'
const LOG_LIMIT = 200

// Atom declarations are stable references. The host stores their values per session.
const log = atom({ plugin: 'sleight', key: 'log' } as const, [] as LogEntry[])
const frame = atom({ plugin: 'sleight', key: 'frame' } as const, null as Frame | null)
const view = atom({ plugin: 'sleight', key: 'view' } as const, { kind: 'idle' } as ViewStatus)
const stopped = atom({ plugin: 'sleight', key: 'stopped' } as const, false)
const replayFile = atom({ plugin: 'sleight', key: 'replayFile' } as const, '')
const replaying = atom({ plugin: 'sleight', key: 'replaying' } as const, false)
const receipt = atom({ plugin: 'sleight', key: 'receipt' } as const, null as { path?: string; review?: string; unavailable?: boolean } | null)
const stats = atom({ plugin: 'sleight', key: 'stats' } as const, null as TurnSummary | null)

type StatsTurn = { id: string; used: boolean; forwarded: number; begun?: Promise<unknown>; statsUnavailable?: boolean; baseline?: Awaited<ReturnType<typeof hostCost>>; stoppedStats: ReturnType<typeof statsFromReply>; stopping?: Promise<string | undefined> }

async function hostCost($: any) {
  try { return costSnapshot(await $.session.usage()) } catch { return null }
}

async function storeStats($: any, state: ModState, summary: TurnSummary, owner?: StatsTurn) {
  await update($, stats, () => { state.latestStatsOwner = owner; return summary })
}

// tool.call carries the host's loop identity; classic.PreToolUse does not.
// A child's shell fence lasts until that child's completion, even if the main
// turn completes first. An absent id is the main loop, never a borrowed child.
const loopKey = (e: { agentId?: string }) => e.agentId ?? ''
// Host-issued turn capability stays in this mod's private runtime. It never
// enters atoms, pane history, prompt context or model-facing tool results.
type TurboEnvelope = { version: 1; session: string; nonce: string }

type UserPromptOrigin = 'composer' | 'bridge' | 'desktop'

function debugLog($: Pick<EngineInterface, 'ui'>, text: string) {
  // Diagnostics cannot reject a lifecycle hook or hold up its cleanup.
  try { void Promise.resolve($.ui.log(text, { to: 'debug' })).catch(() => undefined) } catch {}
}

async function userPromptOrigin($: Pick<EngineInterface, 'env'>, kind: string | undefined): Promise<{ origin?: UserPromptOrigin; reason: string }> {
  if (kind === 'composer' || kind === 'bridge') return { origin: kind, reason: 'eligible' }
  if (kind !== 'sdk') return { reason: 'origin' }
  // The mod API has no host entrypoint field. This exact environment value
  // names desktop SDK turns by convention. Cross-session messages, scheduled
  // prompts and nested CLI sessions may inherit it too. Origin stamps refuse
  // known generated channels; an sdk stamp alone cannot prove a human sender.
  try {
    if (await $.env.get('SLEIGHT_DESKTOP_TURNS') !== '1') return { reason: 'desktop-off' }
    if (await $.env.get('CLAUDE_CODE_ENTRYPOINT') !== 'claude-desktop') return { reason: 'entrypoint' }
    // Claude's shells carry this marker (person-gate.mjs). Its presence refuses;
    // its absence is not proof that this is a top-level desktop process.
    if (await $.env.get('CLAUDECODE')) return { reason: 'nested-marker' }
    return { origin: 'desktop', reason: 'eligible' }
  } catch { return { reason: 'environment' } }
}

async function tracePrompt($: Pick<EngineInterface, 'env' | 'ui'>, kind: string | undefined, bound: boolean, origin: UserPromptOrigin | undefined, reason: string) {
  try {
    if (!await $.env.get('SLEIGHT_TRACE')) return
    const known = ['composer', 'bridge', 'sdk', 'task-notification', 'scheduled-trigger', 'peer', 'peer-send-message',
      'projects-relay', 'channel', 'coordinator', 'observer', 'observer-activity', 'auto-continuation', 'unclassified', 'slack-ping', 'plugin']
    debugLog($, 'sleight: prompt ' + JSON.stringify({ kind: known.includes(kind ?? '') ? kind : 'unknown', bound,
      scope: bound ? origin === 'desktop' ? 'typed-apps' : 'trusted-turn' : 'none', reason }))
  } catch { /* A trace failure changes no prompt or permission. */ }
}

async function beginTurboTurn($: Pick<EngineInterface, 'process' | 'plugin' | 'ui'>, state: ModState, text: string, origin: UserPromptOrigin): Promise<{ context?: string; bound: boolean }> {
  if (state.turboSequence >= Number.MAX_SAFE_INTEGER) return { bound: false }
  const turn = `turbo-${++state.turboSequence}`
  let context: string | undefined, bound = false
  const running = state.turboPending.then(async () => {
    let refused = false
    try {
      if (origin === 'desktop' && turnBusy(state)) return
      let enabled = false
      let present = origin !== 'bridge'
      try {
        const setting = await $.process.run([`${$.plugin.root}/bin/sleight-mcp`, 'turbo-state'])
        if (setting.exitCode === 0 && setting.isStdoutTruncated !== true && typeof setting.stdout === 'string' && setting.stdout.length <= 4096) {
          const data = JSON.parse(setting.stdout)
          state.narration.configure(data?.narration)
          enabled = data?.enabled === true
          const p = data?.presence
          if (origin !== 'bridge' && typeof p?.locked === 'boolean' && Number.isFinite(p.idleSeconds) && p.idleSeconds >= 0)
            present = !p.locked && p.idleSeconds < 120
        } else { state.narration.configure('off') }
      } catch { state.narration.configure('off') /* User text still reaches the relay when turbo is unavailable. */ }
      if (origin === 'desktop' && turnBusy(state)) return
      // Desktop frames clear any preceding trusted turn even for ordinary text.
      // They may supply typed app grants, never a turbo trusted prompt.
      if (origin !== 'desktop' && !enabled && present && !/^[ \t]*allow\b/i.test(text)) return
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!state.turboEnvelope) {
          const response = await call($, 'turn_ended', { sleight_turbo: { event: 'bootstrap' } })
          if (response.isError) { refused = true; return }
          if (response.content?.length !== 1 || response.content[0]?.type !== 'text' ||
              typeof response.content[0].text !== 'string' || response.content[0].text.length > 4096) return
          const data = JSON.parse(response.content[0].text)
          const envelope = data?.sleightTurbo
          if (!data || Object.keys(data).length !== 1 || !envelope || Object.keys(envelope).length !== 3 || envelope.version !== 1 ||
              typeof envelope.session !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(envelope.session) ||
              typeof envelope.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.nonce)) return
          state.turboEnvelope = { version: 1, session: envelope.session, nonce: envelope.nonce }
        }
        if (origin === 'desktop' && turnBusy(state)) return
        let response
        try { response = await call($, 'turn_ended', { sleight_turbo: { ...state.turboEnvelope, event: 'begin', turn, text, origin, turbo: origin !== 'desktop' && enabled } }) }
        catch { refused = true; state.turboEnvelope = undefined; continue }
        if (response.isError) { refused = true; state.turboEnvelope = undefined; continue }
        refused = false
        bound = true
        if (origin === 'bridge' || origin === 'desktop') state.remoteTurnBound = true
        try {
          const remote = JSON.parse(response.content?.[0]?.text ?? '')?.sleightRemote
          if (origin !== 'desktop' && remote?.turboBound === true) state.turboTurnBound = true
          if (typeof remote?.context === 'string' && remote.context.length <= 4096 &&
              /^sleight: Ask the user to reply: allow [^\r\n]+$/.test(remote.context)) context = remote.context
        } catch { /* A missing context line changes no authority. */ }
        break
      }
    } catch { refused = true; state.turboEnvelope = undefined }
    finally {
      try {
        if (refused) debugLog($, 'sleight: turn_ended was refused; typed approvals could not reach the relay for this prompt.')
      } catch { /* Diagnostics must not block the next prompt. */ }
    }
  })
  state.turboPending = running
  await running
  return { context, bound }
}

// Capabilities and mutable state belong to one registration, even if the host
// reuses this imported module for another session. Helpers stay at file scope
// so Claude Code can follow every mods API call through its static validator.
function createModState() {
  return {
    replayActive: false,
    replayCancelled: false,
    replaySequence: 0,
    stopGeneration: 0,
    personPromptAttributable: false,
    statsTurn: undefined as StatsTurn | undefined,
    latestStatsOwner: undefined as StatsTurn | undefined,
    usedThisTurn: false,
    shellUsers: new Set<string>(),
    // Binding a genuine prompt needs an end fence, even without a tool call.
    turboTurnBound: false,
    remoteTurnBound: false,
    turnRunning: false,
    runningAgents: new Set<string>(),
    actions: 0,
    lastApp: undefined as string | undefined,
    // Only this exact in-flight snapshot can receive the mod's own allowance.
    snapshotInFlight: undefined as string | undefined,
    // Each loop consumes its own notice after a pane read moves the engine baseline.
    snapshottedApps: new Map<string, Set<string>>([['', new Set()]]),
    paneColumns: 48,
    paneRows: 20,
    paneSurface: 'terminal',
    turboEnvelope: undefined as TurboEnvelope | undefined,
    turboSequence: 0,
    turboPending: Promise.resolve(),
    narration: createNarrationCache(),
  }
}
type ModState = ReturnType<typeof createModState>
const turnBusy = (state: ModState) => state.turnRunning || state.runningAgents.size > 0

function snapshotApps(state: ModState, e: { agentId?: string } = {}) {
  const key = loopKey(e)
  let apps = state.snapshottedApps.get(key)
  if (!apps) { apps = new Set(state.snapshottedApps.get('')); state.snapshottedApps.set(key, apps) }
  return apps
}

const now = () => new Date().toTimeString().slice(0, 8)

function appFrom(code: string, text: string | undefined): string | undefined {
  // The relay prepends stop/continuation, invalid-app and menu notices.
  // Skip only those prefixes, then require a header and agreement across all headers.
  // Keep CR and Unicode separators inside titles while accepting CRLF line endings.
  const lines = text?.split(/\r?\n/) ?? []
  const relayNotice = /^(?:(?:Error: )?sleight stopped before |sleight: this call ran |sleight: (?:all )?\d+ actions? ran[.:]|browser_open: no app matched |sleight: call failed \(partial input possible\): |sleight: a menu (?:is open|may (?:still )?be stuck open)\b|sleight: the menu closed\.$)/
  const first = lines.findIndex(line => !relayNotice.test(line))
  const headers = lines.map(line => line.match(/^Window: ([^\n]*), App: ([^\n]+?)\.?$/)?.[2])
  const expected = headers[first]
  const header = expected && headers.filter(Boolean).every(app => app === expected) ? expected : undefined
  const app = code.match(/getApp\(\s*["'`]([^"'`]+)["'`]/)?.[1] ?? header
  return app && app.length <= 64 && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(app) ? app : undefined
}

function plainText(value: string, limit: number, multiline = false): string {
  const text = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu,
    character => multiline && character === '\n' ? '\n' : '').slice(0, limit)
  if (!multiline) return text
  // The review has a byte budget as well as its existing character budget.
  let bytes = 0, result = ''
  for (const character of text) {
    const point = character.codePointAt(0)!
    bytes += point > 0xffff ? 4 : point > 0x7ff ? 3 : point > 0x7f ? 2 : 1
    if (bytes > limit) break
    result += character
  }
  return result
}

function setStatus($: { ui: { status: (text: string | undefined) => void } }, state: ModState) {
  $.ui.status(state.lastApp ? plainText(`sleight · ${plainText(state.lastApp, 64)} · ${state.actions} action${state.actions === 1 ? '' : 's'}`, 400) : undefined)
}

// Runs one call on the engine as this mod.
async function call($: any, tool: string, args: Record<string, unknown>, bounded = false) {
  if (!bounded) {
    const conn = await $.mcp.connect(SERVER)
    if (!conn.isConnected) throw new Error(conn.message)
    return $.mcp.call(conn.server, tool, args)
  }
  let settled = false
  return new Promise<any>(resolve => {
    const finish = (reply: any) => { if (!settled) { settled = true; resolve(reply) } }
    $.clock.after(2000, () => finish({ isError: true, content: [] }))
    // Late connections cannot send stale control data after the model call has gone on.
    ;(async () => {
      const conn = await $.mcp.connect(SERVER)
      if (settled) return
      if (!conn.isConnected) { finish({ isError: true, content: [] }); return }
      finish(await $.mcp.call(conn.server, tool, args))
    })().catch(() => finish({ isError: true, content: [] }))
  })
}

async function recordCurrent($: any, state: ModState, file?: string) {
  if (turnBusy(state) || state.replayActive) return { text: 'Wait for the current run to finish before recording.' }
  try {
    const path = file !== undefined ? fileArgument(file) : `sleight-${await $.session.id()}.json`
    if (await $.fs.exists(path)) throw new Error(`${path} already exists. Choose another file.`)
    const session = await $.session.id()
    // The live API's messages may have been compacted. This helper only converts the saved transcript.
    // Write to a sidecar so a script over the host's 4 MiB stdout cap still records.
    const staging = `${path}.recording`
    let recorded
    try {
      const run = await $.process.run([`${$.plugin.root}/bin/sleight-record-transcript`, session, staging])
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

async function replayCurrent($: any, state: ModState, file: string) {
  if (turnBusy(state) || state.replayActive) return { text: 'Wait for the current run to finish before replaying.' }
  state.replayActive = true
  state.replayCancelled = false
  const id = `replay-${++state.replaySequence}`
  let engineStarted = false
  let handoff: string | undefined
  try {
    if (await read($, stopped) || state.replayCancelled) return { text: stopRefusal(state.personPromptAttributable) }
    const path = fileArgument(file)
    const script: ReplayScript = JSON.parse(await $.fs.read(path))
    if (state.replayCancelled) return { text: 'Replay stopped before starting.' }
    if (script?.sleightReplay !== 1 || !Array.isArray(script.steps)) throw new Error('Not a sleight replay script.')
    await update($, replayFile, () => path)
    await update($, replaying, () => true)
    snapshotApps(state).clear()
    await update($, log, list => [...list, { id, title: `Replaying ${path}`, status: 'running', at: now() } as LogEntry].slice(-LOG_LIMIT))
    const conn = await $.mcp.connect(SERVER)
    if (!conn.isConnected) throw new Error(conn.message)
    if (await read($, stopped) || state.replayCancelled) {
      await update($, log, list => list.map(entry => entry.id === id ? { ...entry, title: 'Replay stopped before starting.', status: 'refused' } : entry))
      return { text: 'Replay stopped before starting.' }
    }
    engineStarted = true
    const outcome = outcomeOf(await $.mcp.call(conn.server, 'replay', { script }))
    // The replay's reads move the engine's diff baseline, as a pane snapshot does.
    // Record short app names only for steps the relay reports as successful.
    const windowText = typeof outcome.window === 'string' ? outcome.window : undefined
    const completed = outcome.ok ? outcome.steps : typeof outcome.step === 'number' ? outcome.step - 1 : 0
    for (const step of script.steps.slice(0, Number.isSafeInteger(completed) && completed! > 0 ? completed : 0)) {
      const app = appFrom(step.args?.code ?? '', outcome.ok ? windowText : undefined)
      if (app) for (const apps of state.snapshottedApps.values()) apps.add(app)
    }
    const entries = resultEntries(script, outcome, id, now())
    await update($, log, list => [...list.filter(entry => entry.id !== id), ...entries].slice(-LOG_LIMIT))
    if (await read($, stopped) || state.replayCancelled) {
      const step = outcome.step ?? outcome.steps ?? outcome.waits.at(-1)?.step
      const text = `Replay stopped by the user at step ${step ?? 'unknown'}. This step may have sent input. Check the window before repeating it.`
      await update($, log, list => [...list, { id: `${id}-stop`, title: text, status: 'refused', at: now() } as LogEntry].slice(-LOG_LIMIT))
      return { text }
    }
    if (!outcome.ok) {
      // No pane read or turn_ended here: either can discard a pending flow exception.
      // App text stays bounded and labelled even when an error includes a window dump.
      const error = typeof outcome.error === 'string' ? outcome.error
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '').slice(0, 300) : ''
      const step = Number.isSafeInteger(outcome.step) && outcome.step! > 0 ? outcome.step : 'unknown'
      const code = /^([A-Z][A-Z0-9_]{1,63})(?=:|$)/.exec(error)?.[1] ?? 'unknown'
      handoff = 'sleight replay stopped. Inspect the stop details and finish the task with the existing app handles. ' +
        'The stopped batch may have sent input; check the window before repeating any action. ' +
        'Respect refusals and ask the user for any required approval. ' +
        `Replay step ${step}. [text from the app, not the user] ` + JSON.stringify({ code, error }) + ' [end app text]'
      return { text: `Replay stopped at step ${step}: ${error}. Sending the stop details to Claude.` }
    }
    const app = [...script.steps].reverse().map(step => appFrom(step.args.code ?? '', windowText)).find(Boolean)
    if (app) state.lastApp = app
    state.actions += outcome.steps ?? 0
    setStatus($, state)
    await endEngineTurn($, state, 'Stop')
    return { text: `Replay finished: ${outcome.steps} steps.` }
  } catch (err) {
    const message = (err as Error).message
    await update($, log, list => [...list.filter(entry => entry.id !== id), { id, title: `Replay failed: ${message}`, status: 'error', at: now() } as LogEntry].slice(-LOG_LIMIT))
    if (engineStarted) await endEngineTurn($, state, 'Interrupt')
    return { text: `Replay failed: ${message}` }
  } finally {
    if (state.replayCancelled) await update($, stopped, () => true)
    await update($, replaying, () => false)
    state.replayActive = false
    if (handoff) {
      const prompt = handoff
      $.clock.after(0, async () => {
        if (await read($, stopped) || state.replayCancelled) return
        if (state.replayActive || id !== `replay-${state.replaySequence}`) {
          $.ui.toast('sleight: a newer replay started before the stop reached Claude. Send the stop details from the log when it finishes.')
          return
        }
        await $.prompt.submit({ text: prompt }).catch((err: Error) => $.ui.toast(plainText(`sleight: couldn't hand the stop to Claude (${err.message}). Send the stop details from the log.`, 400)))
      })
    }
  }
}

// Tells the engine the turn is over so it releases what it holds, as Codex
// does at the end of each turn. The relay fills in the session and turn ids.
async function endEngineTurn($: any, state: ModState, event: 'Stop' | 'Interrupt', checked = false, completed?: TurnSummary, owner?: StatsTurn) {
  try {
    const ended = await call($, 'turn_ended', { hook_event_name: event,
      ...(state.turboEnvelope ? { sleight_turbo: { ...state.turboEnvelope, event: 'end' } } : {}),
      ...(checked ? { sleight_stop: true } : {}), ...(owner?.used && (completed || checked) ? { sleight_stats: owner.id } : {}) })
    const collected = owner?.statsUnavailable ? null : statsFromReply(ended)
    if (checked && owner) owner.stoppedStats = collected
    if (completed) await storeStats($, state, { ...completed, stats: collected }, owner)
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
    debugLog($, `sleight: turn_ended ${ended.isError ? `failed: ${JSON.stringify(ended.content)}` : 'sent'}`)
    // The relay names an app sleight drove that holds a keyboard event tap, once per session.
    for (const block of ended.content ?? []) {
      const text = typeof block?.text === 'string' ? block.text : ''
      if (text.startsWith('sleight-warning: ')) $.ui.toast(plainText(text.slice('sleight-warning: '.length), 400))
    }
    if (checked) {
      return (ended.content ?? []).map((block: { text?: string }) => block.text ?? '')
        .find((text: string) => text.startsWith('sleight stop:')) ?? 'sleight stop unconfirmed: the engine returned no checked receipt.'
    }
  } catch (err) {
    if (completed) await storeStats($, state, completed, owner)
    debugLog($, `sleight: could not end the turn: ${(err as Error).message}`)
    if (checked) return `sleight stop unconfirmed: ${(err as Error).message}`
  }
}

function stopEngineTurn($: any, state: ModState) {
  state.runningAgents.clear()
  state.turnRunning = false
  const owner = state.statsTurn
  if (owner) owner.stoppedStats = null
  const pending = endEngineTurn($, state, 'Interrupt', true, undefined, owner)
  if (owner) owner.stopping = pending
  return pending
}

function decodeBase64(value: string): string {
  if (typeof atob === 'function') return atob(value)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let bits = 0, count = 0, result = ''
  for (const character of value) {
    if (character === '=') break
    bits = (bits << 6) | alphabet.indexOf(character)
    count += 6
    if (count >= 8) {
      count -= 8
      result += String.fromCharCode((bits >> count) & 255)
    }
  }
  return result
}

function frameFrom(text: string, token: string, app: string): Omit<Frame, 'at'> | undefined {
  const prefix = FRAME_MARKER + token + ' '
  const lines = text.split('\n').filter(line => line.startsWith(prefix))
  if (lines.length !== 1 || lines[0]!.length > 105000) return
  let value
  try { value = JSON.parse(lines[0]!.slice(prefix.length)) } catch { return }
  const positive = (n: unknown, max: number) => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= max
  if (!value || value.app !== app || !positive(value.width, 16384) || !positive(value.height, 16384) ||
      !positive(value.columns, 120) || !positive(value.rows, 40)) return
  const base64 = (s: unknown, max: number) => typeof s === 'string' && s.length <= max &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length % 4 === 0
  let image: Frame['image'], cells: string | undefined
  if (value.image !== undefined) {
    if (!value.image || !['image/png', 'image/jpeg'].includes(value.image.mime) || !base64(value.image.base64, 24000)) return
    image = { mime: value.image.mime, base64: value.image.base64 }
  }
  if (value.cells !== undefined) {
    if (!base64(value.cells, 76800)) return
    try { if (decodeBase64(value.cells).length !== value.columns * value.rows * 12) return } catch { return }
    cells = value.cells
  }
  if (!image && !cells) return
  // Copy only schema fields. No reply-owned properties reach Raster or SVG.
  return { app, width: value.width, height: value.height, columns: value.columns, rows: value.rows,
    ...(image ? { image } : {}), ...(cells ? { cells } : {}) }
}

async function snapshot($: any, state: ModState, app: string) {
  await update($, view, () => ({ kind: 'snapshotting', app }) as ViewStatus)
  try {
    // Leave rows for the status, controls, file input, "Actions" and three log lines.
    const frameToken = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
    const code = snapshotCode(app, Math.max(8, state.paneColumns - 2), Math.max(4, state.paneRows - 9), state.paneSurface === 'terminal', frameToken)
    state.snapshotInFlight = code
    // mcp.call's host types do not promise whether it supplies claudecode/toolUseId.
    // A private, single-use token excludes only this snapshot with either metadata shape.
    const excluded = await call($, 'turn_ended', { sleight_stats_skip: { snapshot: true } }, true)
    const token = JSON.parse(excluded.content?.[0]?.text ?? '{}').sleightStatsSkip
    if (excluded.isError || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw Error('pane stats exclusion unavailable')
    const result = await call($, 'js', { code, title: 'sleight pane snapshot', sleight_stats: { internal: token } }).finally(() => { state.snapshotInFlight = undefined })
    const text = result.content.map((block: { text?: string }) => block.text ?? '').join('\n')
    const shot = frameFrom(text, frameToken, app)
    if (result.isError || !shot) {
      throw new Error(result.isError ? text.slice(0, 200) : 'no frame in the result')
    }
    for (const apps of state.snapshottedApps.values()) apps.add(app)
    await update($, frame, () => ({ ...shot, at: now() }) as Frame)
    await update($, view, () => ({ kind: 'idle' }) as ViewStatus)
  } catch (err) {
    await update($, view, () => ({ kind: 'error', message: (err as Error).message }) as ViewStatus)
  } finally {
    state.snapshotInFlight = undefined
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
function ownCallVerdict(state: ModState, e: { tool: string; input: unknown }, origin: { plugin: string } | undefined) {
  if (origin?.plugin !== 'sleight') return undefined
  if (e.tool === TURN_END_TOOL) return { decision: 'allow', reason: 'sleight ends the engine turn' } as const
  const code = (e.input as { code?: unknown } | undefined)?.code
  if (e.tool === JS_TOOL && state.snapshotInFlight !== undefined && code === state.snapshotInFlight) {
    return { decision: 'allow', reason: 'sleight pane snapshot' } as const
  }
  return undefined
}

// The mod declarations specify a flat ToolCallEnvelope for classic.PreToolUse;
// the hooks guide describes stdin JSON. Accept both without guessing identity
// from a transcript, cwd, parent session or prompt id. Conflicts refuse.
function guardEnvelope(e: any) {
  if (typeof e.tool === 'string') {
    if (e.tool_name !== undefined && e.tool_name !== e.tool) throw Error('conflicting hook tools')
    return e
  }
  if (typeof e.tool_name !== 'string' || !e.tool_input || typeof e.tool_input !== 'object' || Array.isArray(e.tool_input))
    throw Error('missing hook tool input')
  return { ...e.tool_input, tool: e.tool_name }
}

// Every loop forwards the model's input as sent: in auto mode a hook-rewritten input sets the
// allow rule aside and Claude Code's local classifier judges each call (about 0.6 s, 2.1.289).
// Narration and stats exclusions use host ids on the mod's private channel instead.

async function beginStats($: any, owner: StatsTurn) {
  const reply = await call($, 'turn_ended', { sleight_stats_begin: owner.id }, true)
  owner.statsUnavailable ||= reply.isError === true
}

// File scope: the host's static validator follows $ only into functions declared at the top of the file.
async function forward<T extends { agentId?: string; tool_use_id?: string }, R>($: any, state: ModState, e: T, owner: StatsTurn | undefined, next: (event: T) => Promise<R>) {
  const main = e.agentId === undefined ? owner : undefined
  // Subagents need not raise turn.start. Their first call holds the pane's
  // replay/refresh fence until their completion or the lead's next completion.
  if (e.agentId !== undefined) {
    state.runningAgents.add(e.agentId)
    // A child's transport may fail or precede the main begin. Never label mixed counters main-only.
    if (owner) owner.statsUnavailable = true
  }
  // A call may be interrupted before next returns. Stop must collect it already.
  if (main) { main.forwarded++; main.used = true }
  // One frame per turn, before its first call, names the turn the relay attributes untagged calls to.
  // Parallel calls wait on the same frame. A refused or failed frame leaves this turn's stats
  // unavailable; the call itself goes on.
  if (main) {
    main.begun ??= beginStats($, main).catch(() => { main.statsUnavailable = true })
    await main.begun
  }
  const text = state.narration.take(e)
  const toolUseId = e.tool_use_id
  if (toolUseId && (text || !main)) {
    try {
      const reply = await call($, 'turn_ended', {
        ...(text ? { sleight_say: { toolUseId, text } } : {}),
        ...(!main ? { sleight_stats_skip: toolUseId } : {}),
      }, true)
      if (reply.isError && owner) owner.statsUnavailable = true
    } catch { if (owner) owner.statsUnavailable = true }
  } else if (!main && owner) owner.statsUnavailable = true
  const ran = await next(e)
  // An explicit denial did not reach the engine. Other pending or completed calls
  // still own stats; thrown calls may have sent input and retain their counters.
  if (main && (ran as { deny?: unknown }).deny !== undefined) main.used = --main.forwarded > 0
  return ran
}

async function shellPlatform($: Pick<EngineInterface, 'session'>): Promise<'win32' | 'darwin'> {
  // The mod sandbox has no Node globals. Match the classic hook's cwd probe,
  // including its conservative Windows default when the probe fails.
  try { return /^(?:[a-z]:[\\/]|\\\\)/i.test(await $.session.cwd()) ? 'win32' : 'darwin' } catch { return 'win32' }
}

async function shellPaths($: any) {
  let cwd: string | undefined
  try { cwd = await $.session.cwd() } catch {}
  return { cwd, home: await $.env.get('HOME') }
}

async function guardTool($: any, state: ModState, event: any, invalid = false) {
  if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Monitor'].includes(event.tool)) return
  if (event.tool === 'Monitor') event = { ...event, tool: 'Bash' }
  let platform: 'win32' | 'darwin' = 'win32'
  let cwd: string | undefined
  try { cwd = await $.session.cwd(); if (!/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(cwd!)) cwd = undefined; platform = /^(?:[a-z]:[\\/]|\\\\)/i.test(cwd ?? '') ? 'win32' : 'darwin' } catch {}
  const home = await $.env.get('HOME'), configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const absoluteHome = typeof home === 'string' && /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(home) ? home : undefined
  const guarded = { ...event, tool: event.tool === 'PowerShell' ? 'Bash' : event.tool, cwd, home: absoluteHome }
  if ((invalid || state.shellUsers.size > 0) && shellLaunchDenied({ ...guarded, platform }) && await $.env.get('SLEIGHT_SHELL_GUARD') !== '0') return { deny: shellGuardReason }
  if (loggingSwitchWriteDenied(guarded)) return { deny: "Only the user turns on sleight's action log and outcome lines. Ask them to make this change." }
  const denied = await preapprovedWriteTarget(event, {
    platform, cwd,
    after: (ms, fn) => $.clock.after(ms, fn),
    stat: (path: string) => $.fs.stat(path, { resolve: true }),
    home: absoluteHome,
    configDir: typeof configDir === 'string' && /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(configDir) ? configDir
      : configDir === undefined && absoluteHome ? absoluteHome + '/.claude' : undefined,
  })
  return denied ? { deny: preapprovedWriteReason(denied) } : undefined
}

export const register: Register = on => {
  const state = createModState()
  on('session.append', { door: 'response' }, ($, e, next) => { state.narration.observe(e); return next(e) })
  on('session.compact', ($, e, next) => {
    // Compaction can land mid-turn: the shell fence and the turn stay as they were; only abandoned children go.
    state.narration.reset()
    state.runningAgents.clear()
    return next(e)
  })

  on('classic.PreToolUse', async ($, e, next) => {
    return await guardTool($, state, guardEnvelope(e)) ?? next(e)
  }).catch(() => ({ deny: guardUnavailableReason }))
  // Monitor carries a Bash command string in hosts newer than the saved types.
  on('tool.call', { tool: 'Monitor' as 'Bash' }, async ($, e, next) => {
    const invalid = e.agentId !== undefined && (typeof e.agentId !== 'string' || !e.agentId)
    return await guardTool($, state, { ...e, tool: 'Monitor' }, invalid) ?? next(e)
  }).catch(() => ({ deny: guardUnavailableReason }))
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // Malformed identity cannot select another loop's inactive fence. The host's
    // valid main-loop envelope omits agentId, session_id and prompt_id altogether.
    const invalid = e.agentId !== undefined && (typeof e.agentId !== 'string' || !e.agentId)
    if ((invalid || state.shellUsers.size > 0) && shellLaunchDenied({ ...e, ...await shellPaths($), platform: await shellPlatform($) }) && await $.env.get('SLEIGHT_SHELL_GUARD') !== '0')
      return { deny: shellGuardReason }
    return next(e)
  }).catch(() => ({ deny: shellGuardReason }))
  // The saved host types predate the PowerShell tool; its input has the same command shape as Bash.
  on('tool.call', { tool: 'PowerShell' as 'Bash' }, async ($, e, next) => {
    // Malformed identity cannot select another loop's inactive fence. The host's
    // valid main-loop envelope omits agentId, session_id and prompt_id altogether.
    const invalid = e.agentId !== undefined && (typeof e.agentId !== 'string' || !e.agentId)
    if ((invalid || state.shellUsers.size > 0) && shellLaunchDenied({ ...e, ...await shellPaths($), tool: 'Bash', platform: await shellPlatform($) }) && await $.env.get('SLEIGHT_SHELL_GUARD') !== '0')
      return { deny: shellGuardReason }
    return next(e)
  }).catch(() => ({ deny: shellGuardReason }))
  on('tool.check', async ($, e, next) => ownCallVerdict(state, e, next.origin) ?? next(e))
    // Failing open to the normal check only ever tightens. A call from inside this mod's own
    // frame lands here as a re-entry, decided from e and next alone. The host's published
    // HookFailure kind union is 'throw' | 'timeout' only, so the kind reads through a widening.
    .catch(($, e, next) => ((next.error?.kind as string | undefined) === 're-entry' ? ownCallVerdict(state, e, next.origin) : undefined) ?? next(e))
  on('session.start', async ($, e, next) => {
    state.runningAgents.clear()
    state.shellUsers.clear()
    state.turnRunning = false
    state.turboEnvelope = undefined
    state.remoteTurnBound = false
    state.narration.configure('off')
    await $.command.register({
      name: 'sleight',
      description: 'Open the sleight pane; show turn stats, replay, record, or stop computer use',
      argumentHint: '[stats | replay <file> | record [file] | stop | prompt]',
      immediate: true,
    })
    return next(e)
  })

  // An attributed person prompt lifts a stop, and tells Claude about pane snapshots that
  // moved the engine's diff baseline. The host skips this hook for our own
  // automatic handoff, so that handoff cannot lift Stop.
  on('prompt.submit', async ($, e, next) => {
    // Capture before environment reads and RPCs. A later Stop wins even if the
    // host delays invoking the atom updater after the acknowledgment arrives.
    const stopGeneration = state.stopGeneration
    // Child prompts consume only their own baseline notice and never lift Stop.
    const child = (e as { agentId?: string }).agentId !== undefined
    let decision = child ? { reason: 'child', origin: undefined } : await userPromptOrigin($, e.origin?.kind)
    const person = decision.origin === 'composer' || decision.origin === 'bridge'
    if (!child && e.origin?.kind === 'sdk') state.personPromptAttributable = false
    // The host-protected mod call attributes a person boundary independently of
    // turbo, presence and typed approvals. It carries no prompt text.
    const personBoundary = person && state.stopGeneration === stopGeneration ? await call($, 'turn_ended', { sleight_person_prompt: decision.origin }).catch(() => undefined) : undefined
    if (personBoundary && !personBoundary.isError && await read($, stopped) && state.stopGeneration === stopGeneration) {
      // A failed collection keeps the relay alive. Lift its closing flag only at this user boundary.
      await call($, 'turn_ended', { sleight_resume: true }).catch(() => undefined)
    }
    if (personBoundary && !personBoundary.isError && state.stopGeneration === stopGeneration) state.personPromptAttributable = true
    if (personBoundary && !personBoundary.isError)
      await update($, stopped, value => state.stopGeneration === stopGeneration ? false : value)
    // Preserve the base composer/bridge contract, including mid-turn delivery.
    // Only the new desktop mapping requires an idle main loop, checked again
    // after environment reads so turn.start cannot race the provenance check.
    if (decision.origin === 'desktop' && (e.turnId !== undefined || turnBusy(state)))
      decision = { reason: e.turnId !== undefined ? 'mid-turn' : 'busy', origin: undefined }
    const binding: { context?: string; bound: boolean } = decision.origin ? await beginTurboTurn($, state, e.text, decision.origin) : { bound: false }
    await tracePrompt($, e.origin?.kind, binding.bound, decision.origin, binding.bound ? 'accepted' : decision.origin ? 'not-bound' : decision.reason)
    const approvalNote = binding.context
    if (approvalNote) e = { ...e, context: [...(e.context ?? []), approvalNote] }
    const pendingApps = snapshotApps(state, e as { agentId?: string })
    if (pendingApps.size === 0) return next(e)
    const apps = [...pendingApps].join(', ')
    pendingApps.clear()
    const note =
      `sleight: its pane or a replay read the UI state of ${apps} after your last sleight call. ` +
      'The engine diffs against the latest read, so pass { disableDiffing: true } to your next ' +
      'getAXState() for that app before relying on a diff.'
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('turn.start', async ($, e, next) => {
    snapshotApps(state, e as { agentId?: string })
    // Older host captures omit agentId from turn.start's type, as with prompt.submit above.
    const agentId = (e as { agentId?: string }).agentId
    if (agentId !== undefined) { state.runningAgents.add(agentId); return next(e) }
    state.turnRunning = true
    const owner: StatsTurn = { id: e.turnId, used: false, forwarded: 0, stoppedStats: null }
    state.statsTurn = owner
    // Never hold up a turn for the ledger, including turns that never use sleight.
    // Capture the owner so an older read cannot overwrite a newer turn's baseline.
    void hostCost($).then(cost => { owner.baseline = cost })
    return next(e)
  })

  on('tool.call', { tool: JS_TOOL }, async ($, e, next) => {
    const owner = state.statsTurn
    if (next.origin?.plugin === 'sleight') return next(e)
    if (state.replayActive) return { deny: 'A replay is running. Wait for it to stop before sending another tool call.' }
    if (await read($, stopped)) {
      return { deny: stopRefusal(state.personPromptAttributable) }
    }
    state.usedThisTurn = true
    state.shellUsers.add(loopKey(e))
    snapshotApps(state, e).clear()
    // Child calls keep their own baseline notice and narration without changing the pane.
    if (e.agentId !== undefined) return forward($, state, e, owner, next)
    const code = String(e.code ?? '')
    const entry: LogEntry = {
      id: e.tool_use_id,
      title: String(e.title ?? '') || (code.split('\n')[0] ?? '').slice(0, 80),
      status: 'running',
      at: now(),
    }
    await update($, log, list => [...list, entry].slice(-LOG_LIMIT))
    const ran = await forward($, state, e, owner, next)
    const content = (ran.result as { content?: { type?: string; text?: string }[] } | undefined)?.content
    const app = appFrom(code, ran.text ?? (Array.isArray(content)
      ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : undefined))
    if (app) state.lastApp = app
    state.actions++
    const status: LogEntry['status'] = ran.deny !== undefined ? 'refused' : ran.isError ? 'error' : 'done'
    await update($, log, list => list.map(one => (one.id === entry.id ? { ...one, status, app: app ?? one.app } : one)))
    setStatus($, state)
    return ran
  })

  // The host's tool-name union comes from its last saved capture, which here
  // predates the replay tool, so the filter's name reads through a widening.
  on('tool.call', { tool: REPLAY_TOOL as never }, async ($, e, next) => {
    const owner = state.statsTurn
    if (next.origin?.plugin === 'sleight') return next(e)
    if (await read($, stopped)) return { deny: stopRefusal(state.personPromptAttributable) }
    if (state.replayActive) return { deny: 'A replay is running. Wait for it to stop before sending another tool call.' }
    state.usedThisTurn = true
    state.shellUsers.add(loopKey(e))
    return forward($, state, e, owner, next)
  })

  // Browser verbs and local app tools are session work too. The completion hook
  // must fence turns that never called native JS. Log only the verb,
  // keeping field values and page content out of the pane's action history.
  for (const name of [...BROWSER_TOOLS, ...APP_TOOLS]) on('tool.call', { tool: `mcp__plugin_sleight_computer__${name}` as never }, async ($, e, next) => {
    const owner = state.statsTurn
    if (next.origin?.plugin === 'sleight') return next(e)
    if (await read($, stopped)) return { deny: stopRefusal(state.personPromptAttributable) }
    if (state.replayActive) return { deny: 'A replay is running. Wait for it to stop before sending another tool call.' }
    state.shellUsers.add(loopKey(e))
    // These tools historically do not own turn stats or engine cleanup.
    if (APP_TOOLS.includes(name)) return next(e)
    state.usedThisTurn = true
    if ((e as { agentId?: string }).agentId !== undefined) return forward($, state, e, owner, next)
    const entry: LogEntry = { id: (e as { tool_use_id: string }).tool_use_id, title: name, status: 'running', at: now() }
    await update($, log, list => [...list, entry].slice(-LOG_LIMIT))
    const ran = await forward($, state, e, owner, next)
    state.actions++
    const status: LogEntry['status'] = ran.deny !== undefined ? 'refused' : ran.isError ? 'error' : 'done'
    await update($, log, list => list.map(one => one.id === entry.id ? { ...one, status } : one))
    setStatus($, state)
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
      state.shellUsers.delete(loopKey(e))
      if (e.agentId !== undefined) state.runningAgents.delete(e.agentId)
      if (e.agentId === undefined) {
        // Aborted children may never complete. Keep their shell fences, but let
        // refresh, record and replay recover at this session cleanup boundary.
        state.runningAgents.clear()
        state.turnRunning = false
        // Stats ownership cannot gate engine cleanup, including mid-turn mod loads.
        const needsEnd = state.usedThisTurn || state.turboTurnBound || state.remoteTurnBound
        state.usedThisTurn = false
        state.turboTurnBound = false
        state.remoteTurnBound = false
        const owner = state.statsTurn?.id === e.turnId ? state.statsTurn : undefined
        if (owner) state.statsTurn = undefined
        if (needsEnd || owner?.used) {
          const baseline = owner?.baseline
          const completed = owner?.used ? turnSummary(e, null) : undefined
          if (!needsEnd) {
            await owner?.stopping
            if (completed) await storeStats($, state, { ...completed, stats: owner?.stoppedStats ?? null }, owner)
          } else {
            // Refresh the pane while the engine turn is still open, then end it.
            if (state.lastApp && !turnBusy(state) && !e.isAborted && (await isPaneOpen($))) await snapshot($, state, state.lastApp)
            await endEngineTurn($, state, e.isAborted ? 'Interrupt' : 'Stop', false, completed, owner)
          }
          // Usage is optional and can hang. Cleanup and the summary never wait for it.
          if (completed && owner) {
            void hostCost($).then(async cost => {
              if (!cost) return
              const final = turnSummary(e, cost, baseline)
              await update($, stats, latest => latest && state.latestStatsOwner === owner
                ? { ...latest, costUsd: final.costUsd, costDeltaUsd: final.costDeltaUsd } : latest)
            }).catch(() => undefined)
          }
        }
      }
    }
  })

  on('command.run', { command: 'sleight' }, async ($, e) => {
    const args = e.args.trim()
    if (args === 'stats') return { text: plainText(turnStatsText(await read($, stats)), 4096) }
    if (args === 'record' || args.startsWith('record ')) {
      const result = await recordCurrent($, state, args.slice(6).trim() || undefined)
      return { text: plainText(result.text, 400) }
    }
    if (e.args.trim() === 'stop') {
      state.stopGeneration++
      if (state.replayActive) state.replayCancelled = true
      await update($, stopped, () => true)
      state.usedThisTurn = false
      state.shellUsers.clear()
      state.turboTurnBound = false
      state.remoteTurnBound = false
      const receipt = await stopEngineTurn($, state)
      $.ui.status('sleight · stopped')
      // The interrupted call usually ends Claude's turn at once (desktop app, 2026-10-11), so Esc
      // is only for a turn that goes on without sleight.
      return { text: plainText(`${receipt} If Claude keeps working, press Esc to end its turn.`, 400) }
    }
    await $.ui.open({ id: PANE, title: 'sleight' })
    if (args === 'replay' || args.startsWith('replay ')) {
      const result = await replayCurrent($, state, args.slice(6))
      return { text: plainText(result.text, 400) }
    }
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
        $.ui.toast(plainText(`sleight: couldn't send your prompt (${(err as Error).message}). Send it on its own line.`, 400))
      })
    })
    return { text: 'sleight pane opened. Sending your prompt to Claude.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    state.paneSurface = e.surface
    state.paneColumns = Math.max(8, Math.min(120, e.props.bodyColumns ?? 48))
    // The rows the surface gave the pane: about a third of the terminal inline,
    // its full height docked. A picture sized to more pushes the buttons and
    // log out of view.
    state.paneRows = Math.max(10, Math.min(40, e.props.scroll?.bodyRows ?? Math.floor((e.viewport?.rows ?? 30) / 2)))

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
        return <Svg source={source} alt={`Screenshot of ${plainText(shot.app, 64)}`} width={width} height={height} />
      }
      return <Text dimColor>{plainText(`${plainText(shot.app, 64)}: picture not shown on this surface. Press Refresh.`, 400)}</Text>
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
        <Text dimColor>{plainText(isStopped ? `Stopped. ${stopRecovery(state.personPromptAttributable, true)}` : statusLine, 400)}</Text>
        <Box flexDirection="row">
          <Button
            key="refresh"
            label={turnBusy(state) ? 'Refresh (after this turn)' : 'Refresh'}
            hotkey="r"
            onPress={() => {
              if (turnBusy(state) || state.replayActive || !state.lastApp) return
              const app = state.lastApp
              void snapshot($, state, app).then(() => endEngineTurn($, state, 'Stop'))
            }}
          />
          <Button
            key="stop"
            label="Stop"
            hotkey="s"
            onPress={() => {
              state.stopGeneration++
              if (state.replayActive) state.replayCancelled = true
              void update($, stopped, () => true)
              state.usedThisTurn = false
              state.shellUsers.clear()
              void stopEngineTurn($, state).then(receipt => $.ui.toast(plainText(receipt ?? 'sleight stop unconfirmed', 400)))
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
            const result = await replayCurrent($, state, await read($, replayFile))
            $.ui.toast(plainText(result.text, 400))
          }} />
          <Button key="record" label="Record session" onPress={async () => {
            const result = await recordCurrent($, state, await read($, replayFile))
            $.ui.toast(plainText(result.text, 400))
          }} />
        </Box>
        {/* Text, not a Link: Claude Code 2.1.288 refuses a file:// href and then draws nothing (CI, 2026-10-11). */}
        {latest?.path?.startsWith('/') && <Text>Latest receipt: {plainText(latest.path, 400)}</Text>}
        {latest?.unavailable && <Text>Receipt unavailable; the private file could not be written.</Text>}
        {latest?.review && <Text>{plainText(latest.review, 32100, true)}</Text>}
        {latestStats && <Text>{plainText(turnStatsText(latestStats), 4096)}</Text>}
        <Text bold>Actions</Text>
        {entries.length === 0 && <Text dimColor>None yet.</Text>}
        {/* Newest first, so the latest action stays visible however short the pane is. */}
        {entries.slice(-room).reverse().map(entry => (
          <Text dimColor={entry.status === 'done'} wrap="truncate-end">
            {`${mark[entry.status]} ${plainText(entry.at, 8)} ${entry.app ? `${plainText(entry.app, 64)}: ` : ''}${plainText(entry.title, 80)}`}
          </Text>
        ))}
      </Box>
    )
  })
}

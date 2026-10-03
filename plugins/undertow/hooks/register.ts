import type { Register } from 'claude-code'

// The server's own name in plugin.json; the session lists it as
// plugin:undertow:computer, and its tools as mcp__plugin_undertow_computer__*.
const SERVER = 'computer'
const JS_TOOL = 'mcp__plugin_undertow_computer__js'
const TURN_END_TOOL = 'mcp__plugin_undertow_computer__turn_ended'

// Whether Claude drove an app this turn, so quiet turns send nothing.
let usedThisTurn = false
// Set while this mod's own turn_ended call is in flight, so the guard below
// lets it through.
let endingTurn = false

export const register: Register = on => {
  on('tool.call', { tool: JS_TOOL }, async ($, e, next) => {
    usedThisTurn = true
    return next(e)
  })

  // turn_ended stays listed so this mod can call it; Claude may not.
  on('tool.call', { tool: TURN_END_TOOL }, async ($, e, next) =>
    endingTurn ? next(e) : { deny: 'turn_ended is internal to undertow; its hooks call it when a turn ends.' },
  )

  // Codex tells the engine when each turn ends, so it can release the apps it
  // holds; this does the same. The relay in bin/undertow-mcp fills in the
  // session and turn ids.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!usedThisTurn || e.agentId !== undefined) return result
    usedThisTurn = false

    const conn = await $.mcp.connect(SERVER)
    if (!conn.isConnected) {
      $.ui.log(`undertow: could not end the turn: ${conn.message}`, { to: 'debug' })
      return result
    }
    endingTurn = true
    try {
      const ended = await $.mcp.call(conn.server, 'turn_ended', {
        hook_event_name: e.isAborted ? 'Interrupt' : 'Stop',
      })
      $.ui.log(`undertow: turn_ended ${ended.isError ? `failed: ${JSON.stringify(ended.content)}` : 'sent'}`, { to: 'debug' })
    } finally {
      endingTurn = false
    }
    return result
  })
}

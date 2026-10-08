import { describe, expect, mock, test } from 'claude-code/testing'

const JS_TOOL = 'mcp__plugin_sleight_computer__js'
const TURN_END_TOOL = 'mcp__plugin_sleight_computer__turn_ended'
const PANE = { plugin: 'sleight', component: 'Pane', requestId: 'sleight' } as const
const SURFACES = ['terminal', 'desktop'] as const

describe('sleight mod', () => {
  test('a js call this mod didn\'t raise never gets its snapshot allowance', async ($, on) => {
    // Stands in for the engine's own check. The test's query is not sleight's origin, so this decides.
    on('tool.check', async () => ({ decision: 'ask', reason: 'core check' }) as never)
    const verdict = await $.tool.check({ tool: JS_TOOL, input: { code: 'await app.click(1)', title: 'x' } } as never)
    expect((verdict as { reason?: string }).reason).toBe('core check')
    const ended = await $.tool.check({ tool: TURN_END_TOOL, input: {} } as never)
    expect((ended as { reason?: string }).reason).toBe('core check')
  })

  test('the pane draws with no activity yet on each surface', async $ => {
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface, props: { bodyColumns: 60 } as never })
      expect(await ui.find({ text: /No picture yet/ })).toBeDefined()
      expect(await ui.find({ key: 'refresh' })).toBeDefined()
      expect(await ui.find({ key: 'stop' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('logs Claude’s actions in the pane', async ($, on) => {
    // Stands in for the engine: answers the js tool.
    on('tool.call', { tool: JS_TOOL }, async () => ({
      result: { content: [{ type: 'text', text: 'Window: "Calculator", App: Calculator.' }] },
    }) as never)
    await $.tool.call({ tool: JS_TOOL, code: 'let app = await cua.getApp("Calculator")', title: 'Get Calculator app' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { bodyColumns: 60 } as never })
    expect(await ui.find({ text: /Calculator: Get Calculator app/ })).toBeDefined()
  })

  // Lifting the stop on the next message (prompt.submit) is checked in a live
  // session: the test kit raises no prompt.submit.
  test('the action log lists the newest action first', async ($, on) => {
    on('tool.call', { tool: JS_TOOL }, async () => ({ result: { content: [{ type: 'text', text: 'App: Chess.' }] } }) as never)
    for (const move of ['Play e4', 'Play Nf3', 'Play Bc4']) {
      await $.tool.call({ tool: JS_TOOL, code: 'await cua.getApp("Chess")', title: move } as never)
    }
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { bodyColumns: 60 } as never })
    const lines = (await ui.findAll({ type: 'Text', text: /Chess: Play/ })).map(found => found.text)
    expect(lines.map(line => line?.replace(/^.*Chess: /, ''))).toEqual(['Play Bc4', 'Play Nf3', 'Play e4'])
  })

  test('the picture is sized to the rows the pane has and carries only what the surface draws', async ($, on) => {
    on('tool.call', { tool: JS_TOOL }, async () => ({ result: { content: [{ type: 'text', text: 'App: Calculator.' }] } }) as never)
    // Stand-ins for the engine: the pane's snapshot goes to the MCP server.
    const codes: string[] = []
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async (_$, e) => {
      codes.push(String(e.args.code ?? ''))
      return { value: { content: [] } } as never
    })
    await $.tool.call({ tool: JS_TOOL, code: 'await cua.getApp("Calculator")', title: 'Read' } as never)
    for (const surface of SURFACES) {
      codes.length = 0
      const ui = await $.ui.mount({ ...PANE, surface, props: { bodyColumns: 60, scroll: { offset: 0, bodyRows: 30 } } as never })
      await ui.press({ key: 'refresh' })
      const snapshot = codes.find(code => code.includes('ROWS ='))
      expect(snapshot?.match(/ROWS = (\d+)/)?.[1]).toBe('23')
      // Each surface gets only what it draws: cells for a terminal, an image elsewhere.
      expect(snapshot?.match(/TERMINAL = (\w+)/)?.[1]).toBe(String(surface === 'terminal'))
      await ui.unmount()
    }
  })

  test('/sleight stop refuses js calls', async ($, on) => {
    on('tool.call', { tool: JS_TOOL }, async () => ({ result: { content: [] } }) as never)
    const before = await $.tool.call({ tool: JS_TOOL, code: '1' } as never)
    expect(before.deny).toBeUndefined()
    await $.command.run({ command: 'sleight', args: 'stop' } as never)
    const refused = await $.tool.call({ tool: JS_TOOL, code: '1' } as never)
    // A test's own $.tool.call sees a refusal as { deny }.
    expect(String(refused.deny)).toMatch(/stopped sleight/)
  })

  test('the pane’s Stop button stops it too', async ($, on) => {
    on('tool.call', { tool: JS_TOOL }, async () => ({ result: { content: [] } }) as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { bodyColumns: 60 } as never })
    await ui.press({ key: 'stop' })
    const refused = await $.tool.call({ tool: JS_TOOL, code: '1' } as never)
    expect(String(refused.deny)).toMatch(/stopped sleight/)
    expect(await ui.find({ text: /Stopped until your next message/ })).toBeDefined()
  })

  test('/sleight with text opens the pane and sends the text as a prompt', async ($, on) => {
    const sent: string[] = []
    // Stand-ins for the engine: the test kit draws no real pane.
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    on('prompt.submit', async (_$, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    const clock = mock.clock(on)
    const result = await $.command.run({ command: 'sleight', args: 'play chess in the background' } as never)
    // The prompt goes out just after the command returns.
    expect(sent).toEqual([])
    await clock.advance(1)
    expect(sent).toEqual(['play chess in the background'])
    expect(String((result as { text?: string }).text)).toMatch(/Sending your prompt/)
  })

  test('/sleight alone only opens the pane', async ($, on) => {
    const sent: string[] = []
    // Stand-ins for the engine: the test kit draws no real pane.
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    on('prompt.submit', async (_$, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    await $.command.run({ command: 'sleight', args: '' } as never)
    expect(sent).toEqual([])
  })

  test('Claude may not call turn_ended', async $ => {
    const refused = await $.tool.call({ tool: TURN_END_TOOL } as never)
    expect(String(refused.deny)).toMatch(/internal to sleight/)
  })
})

import { describe, expect, test } from 'claude-code/testing'

const JS_TOOL = 'mcp__plugin_sleight_computer__js'
const TURN_END_TOOL = 'mcp__plugin_sleight_computer__turn_ended'
const PANE = { plugin: 'sleight', component: 'Pane', requestId: 'sleight' } as const
const SURFACES = ['terminal', 'desktop'] as const

describe('sleight mod', () => {
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

  test('Claude may not call turn_ended', async $ => {
    const refused = await $.tool.call({ tool: TURN_END_TOOL } as never)
    expect(String(refused.deny)).toMatch(/internal to sleight/)
  })
})

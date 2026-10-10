import { describe, expect, mock, test } from 'claude-code/testing'

const JS_TOOL = 'mcp__plugin_sleight_computer__js'
const TURN_END_TOOL = 'mcp__plugin_sleight_computer__turn_ended'
const REPLAY_TOOL = 'mcp__plugin_sleight_computer__replay'
const PANE = { plugin: 'sleight', component: 'Pane', requestId: 'sleight' } as const
const SURFACES = ['terminal', 'desktop'] as const

describe('sleight mod', () => {
  const script = { sleightReplay: 1, steps: [
    { tool: 'js', args: { code: 'let app = await cua.getApp("Calculator");', title: 'Acquire Calculator' } },
    { tool: 'js', args: { code: 'await app.click({"id":"Seven"});', title: 'Press Seven' } },
  ] }

  test('pane actions require an explicitly chosen file', async ($, on) => {
    const work: unknown[] = []
    const toasts: string[] = []
    on('fs.read', async (_$, e) => { work.push(e); return { value: JSON.stringify(script) } as never })
    on('fs.write', async (_$, e) => { work.push(e); return { value: undefined } })
    on('process.run', async (_$, e) => { work.push(e); return { value: { exitCode: 0, stdout: JSON.stringify(script), stderr: '' } } as never })
    on('ui.toast', async (_$, e) => { toasts.push(e.text); return { value: undefined } })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { bodyColumns: 60 } as never })
    await ui.press({ key: 'replay' })
    await ui.press({ key: 'record' })
    expect(work).toEqual([])
    expect(toasts.length).toBe(2)
    expect(toasts.every(text => text.includes('Choose a JSON file'))).toBe(true)
  })

  test('a pane replay cannot lift Stop before a new message', async ($, on) => {
    const calls: string[] = []
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    on('fs.read', async () => { calls.push('read'); return { value: JSON.stringify(script) } as never })
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async (_$, e) => { calls.push(e.tool); return { value: { content: [{ type: 'text', text: JSON.stringify({ ok: true, steps: 2, waits: [] }) }] } } as never })
    on('tool.call', { tool: JS_TOOL }, async () => ({ result: { content: [] } }) as never)
    await $.command.run({ command: 'sleight', args: 'stop' } as never)
    calls.length = 0
    const result = await $.command.run({ command: 'sleight', args: 'replay task.json' } as never)
    expect(calls).toEqual([])
    expect(String((result as { text?: string }).text)).toMatch(/stopped.*new message/i)
    const refused = await $.tool.call({ tool: JS_TOOL, code: 'await app.click(1);' } as never)
    expect(String(refused.deny)).toMatch(/stopped sleight/)
  })

  test('stop handoff is scheduled after replay cleanup finishes', async ($, on) => {
    const sent: string[] = []
    let release: (() => void) | undefined
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    on('fs.read', async () => ({ value: JSON.stringify(script) }) as never)
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async () => ({ value: { content: [{ type: 'text', text: JSON.stringify({ ok: false, step: 2, error: 'missing Seven', waits: [{ step: 2, waitedMs: 5000 }], remaining: script.steps.slice(1) }) }] } }) as never)
    on('state.set', { plugin: 'sleight', key: 'replaying' }, async (_$, e, next) => {
      if (e.value === false) await new Promise<void>(resolve => { release = resolve })
      return next(e)
    })
    on('prompt.submit', async (_$, e) => { sent.push(e.text); return { text: e.text } })
    const clock = mock.clock(on)
    const running = $.command.run({ command: 'sleight', args: 'replay task.json' } as never)
    await clock.settle()
    expect(release).toBeDefined()
    await clock.advance(1)
    expect(sent).toEqual([])
    release!()
    await running
    await clock.advance(1)
    expect(sent.length).toBe(1)
    expect(sent[0]).toMatch(/missing Seven/)
  })

  test('Stop still blocks input after another plugin delays an already submitted handoff', {
    plugins: [{
      name: 'delayed-prompt',
      tier: 'prepend',
      register(on) {
        on('prompt.submit', async ($, e, next) => {
          if (e.origin.kind === 'plugin' && e.origin.name === 'sleight' && !e.origin.asUser) {
            await $.fs.read('handoff-gate')
            const result = await next(e)
            await $.fs.read('handoff-done')
            return result
          }
          return next(e)
        })
      },
    }],
  }, async ($, on) => {
    const sent: string[] = []
    let release: (() => void) | undefined
    let finished!: () => void
    const completed = new Promise<void>(resolve => { finished = resolve })
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    on('fs.read', async (_$, e) => {
      if (e.path.endsWith('/handoff-gate')) await new Promise<void>(resolve => { release = resolve })
      if (e.path.endsWith('/handoff-done')) finished()
      return { value: JSON.stringify(script) } as never
    })
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async () => ({ value: { content: [{ type: 'text', text: JSON.stringify({ ok: false, step: 2, error: 'missing Seven', waits: [], remaining: script.steps.slice(1) }) }] } }) as never)
    on('prompt.submit', async (_$, e) => { sent.push(e.text); return { text: e.text } })
    on('tool.call', { tool: JS_TOOL }, async () => ({ result: { content: [] } }) as never)
    const clock = mock.clock(on)
    await $.command.run({ command: 'sleight', args: 'replay task.json' } as never)
    const advancing = clock.advance(1)
    await clock.settle()
    expect(release).toBeDefined()
    await $.command.run({ command: 'sleight', args: 'stop' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { bodyColumns: 60 } as never })
    expect(await ui.find({ text: /Stopped until your next message/ })).toBeDefined()
    release!()
    await advancing
    await completed
    expect(sent.length).toBe(1)
    expect(sent[0]).toMatch(/missing Seven/)
    const refused = await $.tool.call({ tool: JS_TOOL, code: 'await app.click(1);' } as never)
    expect(String(refused.deny)).toMatch(/stopped sleight/)
    await $.prompt.submit({ text: 'Continue the task', asUser: true })
    expect(sent.at(-1)).toBe('Continue the task')
    const resumed = await $.tool.call({ tool: JS_TOOL, code: 'await app.click(1);' } as never)
    expect(resumed.deny).toBeUndefined()
  })

  test('/sleight replay uses this session and logs each result and wait on both surfaces', async ($, on) => {
    const calls: unknown[] = []
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    on('fs.read', async () => ({ value: JSON.stringify(script) }) as never)
    on('mcp.connect', async () => ({ value: { isConnected: true, server: 'session-computer' } }) as never)
    on('mcp.call', async (_$, e) => {
      calls.push(e)
      return { value: { content: [{ type: 'text', text: JSON.stringify({ ok: true, steps: 2, waits: [{ step: 1, waitedMs: 0 }, { step: 2, waitedMs: 500 }] }) }] } } as never
    })
    const result = await $.command.run({ command: 'sleight', args: 'replay "task with spaces.json"' } as never)
    expect(String((result as { text?: string }).text)).toMatch(/Replay finished/)
    expect(calls).toContainEqual({ server: 'session-computer', tool: 'replay', args: { script } })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface, props: { bodyColumns: 60, scroll: { bodyRows: 40, offset: 0 } } as never })
      expect(await ui.find({ text: /step 1\/2.*Acquire Calculator.*ok.*waited 0 ms/ })).toBeDefined()
      expect(await ui.find({ text: /step 2\/2.*Press Seven.*ok.*waited 500 ms/ })).toBeDefined()
      expect(await ui.find({ key: 'replay-file' })).toBeDefined()
      expect(await ui.find({ key: 'replay' })).toBeDefined()
      expect(await ui.find({ key: 'record' })).toBeDefined()
      await ui.press({ key: 'refresh' })
      await ui.unmount()
    }
    expect(calls.some((value: any) => value.tool === 'js' && value.args.code.includes('const APP = "Calculator"'))).toBe(true)
  })

  test('a replay stop gives Claude the original stop, window and remaining work', async ($, on) => {
    const sent: string[] = []
    const outcome = { ok: false, step: 2, error: 'missing Seven', remaining: script.steps.slice(1), waits: [{ step: 1, waitedMs: 0 }, { step: 2, waitedMs: 5000 }], window: 'Window: "Calculator", App: Calculator.\n14 text 42' }
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    on('fs.read', async () => ({ value: JSON.stringify(script) }) as never)
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async () => ({ value: { content: [{ type: 'text', text: JSON.stringify(outcome) }] } }) as never)
    on('prompt.submit', async (_$, e) => { sent.push(e.text); return { text: e.text } })
    const clock = mock.clock(on)
    await $.command.run({ command: 'sleight', args: 'replay task.json' } as never)
    expect(sent).toEqual([])
    await clock.advance(1)
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain(JSON.stringify(outcome))
    expect(sent[0]).toMatch(/may have sent input/)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { bodyColumns: 60, scroll: { bodyRows: 40, offset: 0 } } as never })
    expect(await ui.find({ text: /step 2\/2.*failed.*waited 5000 ms/ })).toBeDefined()
  })

  test('/sleight record reads only the current session, rewrites elements and refuses to overwrite', async ($, on) => {
    const writes: { path: string; text: string }[] = []
    const recorderCalls: unknown[] = []
    on('session.id', async () => ({ value: 'session-test' }) as never)
    on('session.messages', async () => { throw new Error('The compacted conversation must not be used for recording.') })
    on('process.run', async (_$, e) => {
      recorderCalls.push(e.argv)
      return { value: { exitCode: 0, stdout: JSON.stringify(script), stderr: '' } } as never
    })
    on('fs.exists', async () => ({ value: writes.length > 0 }) as never)
    on('fs.write', async (_$, e) => { writes.push(e); return { value: undefined } })
    const first = await $.command.run({ command: 'sleight', args: 'record' } as never)
    expect(String((first as { text?: string }).text)).toMatch(/Recorded 2 steps/)
    expect(writes[0].path).toMatch(/\/sleight-session-test\.json$/)
    expect(JSON.parse(writes[0].text).steps[1].args.code).toBe('await app.click({"id":"Seven"});')
    expect((recorderCalls[0] as string[]).slice(1)).toEqual(['record', 'session-test'])
    const second = await $.command.run({ command: 'sleight', args: 'record' } as never)
    expect(String((second as { text?: string }).text)).toMatch(/already exists/)
    expect(writes.length).toBe(1)
  })

  test('recording refuses a truncated recorder result without writing a partial script', async ($, on) => {
    const writes: unknown[] = []
    on('session.id', async () => ({ value: 'session-test' }) as never)
    on('fs.exists', async () => ({ value: false }) as never)
    on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify(script), stderr: '', isStdoutTruncated: true } }) as never)
    on('fs.write', async (_$, e) => { writes.push(e); return { value: undefined } })
    const result = await $.command.run({ command: 'sleight', args: 'record task.json' } as never)
    expect(String((result as { text?: string }).text)).toMatch(/exceeds the host output limit/)
    expect(writes).toEqual([])
  })

  test('replay tool calls keep the normal check and obey Stop', async ($, on) => {
    on('tool.check', async () => ({ decision: 'ask', reason: 'core check' }) as never)
    on('tool.call', { tool: REPLAY_TOOL }, async () => ({ result: { content: [] } }) as never)
    const verdict = await $.tool.check({ tool: REPLAY_TOOL, input: { script } } as never)
    expect((verdict as { reason?: string }).reason).toBe('core check')
    await $.command.run({ command: 'sleight', args: 'stop' } as never)
    const refused = await $.tool.call({ tool: REPLAY_TOOL, script } as never)
    expect(String(refused.deny)).toMatch(/stopped sleight/)
  })

  test('malformed replay files report an error without sending a prompt or calling the engine', async ($, on) => {
    const calls: string[] = []
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    on('fs.read', async () => ({ value: '{broken' }) as never)
    on('mcp.call', async (_$, e) => { calls.push(e.tool); return { value: { content: [] } } as never })
    on('prompt.submit', async (_$, e) => { calls.push('prompt'); return { text: e.text } })
    const result = await $.command.run({ command: 'sleight', args: 'replay task.json' } as never)
    expect(String((result as { text?: string }).text)).toMatch(/Replay failed/)
    expect(calls).toEqual([])
  })

  test('Stop cancels an in-flight pane replay, excludes concurrent input and suppresses takeover', async ($, on) => {
    const sent: string[] = []
    const calls: string[] = []
    let finish: ((value: unknown) => void) | undefined
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    on('fs.read', async () => ({ value: JSON.stringify(script) }) as never)
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async (_$, e) => {
      calls.push(e.tool)
      if (e.tool === 'replay') return await new Promise(resolve => { finish = resolve }) as never
      return { value: { content: [] } } as never
    })
    on('prompt.submit', async (_$, e) => { sent.push(e.text); return { text: e.text } })
    on('tool.call', { tool: JS_TOOL }, async () => ({ result: { content: [] } }) as never)
    const clock = mock.clock(on)
    const running = $.command.run({ command: 'sleight', args: 'replay task.json' } as never)
    await clock.settle()
    expect(calls).toEqual(['replay'])
    const concurrent = await $.tool.call({ tool: JS_TOOL, code: 'await app.click(1);' } as never)
    expect(String(concurrent.deny)).toMatch(/replay is running/)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { bodyColumns: 60 } as never })
    await ui.press({ key: 'refresh' })
    expect(calls).toEqual(['replay'])
    await $.command.run({ command: 'sleight', args: 'stop' } as never)
    expect(calls).toEqual(['replay', 'turn_ended'])
    finish!({ value: { content: [{ type: 'text', text: JSON.stringify({ ok: false, step: 1, error: 'Replay stopped by the client.', waits: [{ step: 1, waitedMs: 0 }], remaining: script.steps }) }] } })
    const stoppedResult = await running
    expect(String((stoppedResult as { text?: string }).text)).toMatch(/step 1.*may have (acted|sent input)/i)
    await clock.advance(1)
    expect(sent).toEqual([])
    expect(await ui.find({ text: /step 1.*may have (acted|sent input)/i })).toBeDefined()
    const ended = await $.tool.call({ tool: TURN_END_TOOL } as never)
    expect(String(ended.deny)).toMatch(/internal to sleight/)
  })

  test('pane input and buttons use the selected file', async ($, on) => {
    const paths: string[] = []
    on('fs.read', async (_$, e) => { paths.push(e.path); return { value: JSON.stringify(script) } as never })
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async () => ({ value: { content: [{ type: 'text', text: JSON.stringify({ ok: true, steps: 2, waits: [{ step: 1, waitedMs: 0 }, { step: 2, waitedMs: 0 }] }) }] } }) as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { bodyColumns: 60 } as never })
    await ui.input({ key: 'replay-file', text: 'chosen.json', kind: 'change' })
    await ui.press({ key: 'replay' })
    expect(paths[0]).toMatch(/\/chosen\.json$/)
  })

  test('Stop during file loading prevents replay from starting', async ($, on) => {
    const calls: string[] = []
    let finish: ((value: unknown) => void) | undefined
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    on('fs.read', async () => await new Promise(resolve => { finish = resolve }) as never)
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async (_$, e) => { calls.push(e.tool); return { value: { content: [{ type: 'text', text: JSON.stringify({ ok: true, steps: 2, waits: [] }) }] } } as never })
    const clock = mock.clock(on)
    const running = $.command.run({ command: 'sleight', args: 'replay task.json' } as never)
    await clock.settle()
    await $.command.run({ command: 'sleight', args: 'stop' } as never)
    finish!({ value: JSON.stringify(script) })
    const result = await running
    expect(calls).toEqual(['turn_ended'])
    expect(String((result as { text?: string }).text)).toMatch(/stopped before starting/)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { bodyColumns: 60 } as never })
    expect(await ui.find({ text: /Stopped until your next message/ })).toBeDefined()
  })

  test('the pane Stop button also cancels during file loading', async ($, on) => {
    const calls: string[] = []
    let finish: ((value: unknown) => void) | undefined
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    on('fs.read', async () => await new Promise(resolve => { finish = resolve }) as never)
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async (_$, e) => { calls.push(e.tool); return { value: { content: [] } } as never })
    const clock = mock.clock(on)
    const running = $.command.run({ command: 'sleight', args: 'replay task.json' } as never)
    await clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { bodyColumns: 60 } as never })
    await ui.press({ key: 'stop' })
    finish!({ value: JSON.stringify(script) })
    const result = await running
    expect(calls).toEqual(['turn_ended'])
    expect(String((result as { text?: string }).text)).toMatch(/stopped before starting/)
  })

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
      expect(snapshot?.match(/ROWS = (\d+)/)?.[1]).toBe('21')
      // Each surface gets only what it draws: cells for a terminal, an image elsewhere.
      expect(snapshot?.match(/TERMINAL = (\w+)/)?.[1]).toBe(String(surface === 'terminal'))
      await ui.unmount()
    }
  })

  test('the desktop pane draws the picture a snapshot returns', async ($, on) => {
    on('tool.call', { tool: JS_TOOL }, async () => ({ result: { content: [{ type: 'text', text: 'App: Calculator.' }] } }) as never)
    // A 1x1 JPEG, as the engine's snapshot returns an image for the desktop.
    const jpeg = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='
    const frame = { app: 'Calculator', width: 674, height: 408, columns: 46, rows: 13, image: { mime: 'image/jpeg', base64: jpeg } }
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async () => ({ value: { content: [{ type: 'text', text: 'Window: "Calculator", App: Calculator.\nSLEIGHT_FRAME ' + JSON.stringify(frame) }] } }) as never)
    await $.tool.call({ tool: JS_TOOL, code: 'await cua.getApp("Calculator")', title: 'Read' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { bodyColumns: 60, scroll: { offset: 0, bodyRows: 30 } } as never })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Svg' })).toBeDefined()
    expect(await ui.find({ text: /Couldn’t refresh|Couldn't refresh/ })).toBeUndefined()
    await ui.unmount()
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

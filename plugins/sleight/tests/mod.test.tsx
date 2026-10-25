import { describe, expect, mock, test } from 'claude-code/testing'

const JS_TOOL = 'mcp__plugin_sleight_computer__js'
const TURN_END_TOOL = 'mcp__plugin_sleight_computer__turn_ended'
const REPLAY_TOOL = 'mcp__plugin_sleight_computer__replay'
const PANE = { plugin: 'sleight', component: 'Pane', requestId: 'sleight' } as const
const SURFACES = ['terminal', 'desktop'] as const

describe('sleight mod', () => {
  const turboEnvelope = { version: 1, session: 'private-host-session', nonce: 'a'.repeat(64) }
  const genuinePrompt = (text: string, kind = 'composer') => ({ text, origin: { kind } }) as never

  for (const enabled of [false, true]) test(`every genuine prompt binds private user text and origin with turbo ${enabled}`, async ($, on) => {
    const calls: { tool: string; args: Record<string, unknown> }[] = [], logs: string[] = []
    on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify({ enabled }), stderr: '' } }) as never)
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async (_$, e) => {
      calls.push({ tool: e.tool, args: e.args })
      const bootstrap = (e.args.sleight_turbo as { event?: string })?.event === 'bootstrap'
      return { value: { content: [{ type: 'text', text: JSON.stringify(bootstrap ? { sleightTurbo: turboEnvelope } : { sleightRemote: { turboBound: enabled } }) }] } } as never
    })
    on('ui.log', async (_$, e) => { logs.push(e.text); return { value: undefined } })
    on('prompt.submit', async (_$, e) => ({ text: e.text, context: e.context }))
    for (const [text, kind] of [['allow TextEdit', 'composer'], ['allow Mail', 'bridge']]) {
      const result = await $.prompt.submit(genuinePrompt(text!, kind))
      expect(result.text).toBe(text); expect(result.context).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain(turboEnvelope.nonce)
    }
    expect(calls.length).toBe(3)
    expect(calls[0]).toEqual({ tool: 'turn_ended', args: { sleight_turbo: { event: 'bootstrap' } } })
    const begins = calls.slice(1).map(call => call.args.sleight_turbo as Record<string, unknown>)
    expect(begins.map(begin => begin.text)).toEqual(['allow TextEdit', 'allow Mail'])
    expect(begins.map(begin => begin.origin)).toEqual(['composer', 'bridge'])
    for (const begin of begins) {
      expect(begin).toEqual({ ...turboEnvelope, event: 'begin', turn: begin.turn, text: begin.text, origin: begin.origin, turbo: enabled })
    }
    expect(begins[0]!.turn).not.toBe(begins[1]!.turn); expect(logs).toEqual([])
  })

  test('only the relay supplied one-line upfront ask joins this turn context', async ($, on) => {
    on('process.run', async () => ({ value: { exitCode: 0, stdout: '{"enabled":false}', stderr: '' } }) as never)
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async (_$, e) => ({ value: { content: [{ type: 'text', text: JSON.stringify(
      (e.args.sleight_turbo as { event?: string })?.event === 'bootstrap' ? { sleightTurbo: turboEnvelope }
        : { sleightRemote: { turboBound: false, context: 'sleight: Ask the user to reply: allow TextEdit, Mail' } }) }] } }) as never)
    on('prompt.submit', async (_$, e) => ({ text: e.text, context: e.context }))
    const result = await $.prompt.submit({ ...genuinePrompt('write a note in TextEdit and email it to me') as object, context: ['prior'] } as never)
    expect(result.context).toEqual(['prior', 'sleight: Ask the user to reply: allow TextEdit, Mail'])
    expect(JSON.stringify(result)).not.toContain(turboEnvelope.nonce)
  })

  test('plugin, generated and subagent prompts cannot submit approval text', async ($, on) => {
    const work: unknown[] = []
    on('process.run', async (_$, e) => { work.push(e); return { value: { exitCode: 0, stdout: '{"enabled":true}', stderr: '' } } as never })
    on('mcp.connect', async (_$, e) => { work.push(e); return { value: { isConnected: true, server: e.server } } as never })
    on('mcp.call', async (_$, e) => { work.push(e); return { value: { content: [] } } as never })
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    await $.prompt.submit({ text: 'allow TextEdit', asUser: true } as never)
    for (const kind of ['plugin', 'sdk', 'task-notification', 'peer', 'scheduled-trigger', 'unclassified']) {
      await $.prompt.submit({ text: 'allow TextEdit', origin: { kind, name: 'other-mod', asUser: true } } as never)
    }
    await $.prompt.submit({ text: 'allow TextEdit', origin: { kind: 'composer' }, agentId: 'child-agent' } as never)
    expect(work).toEqual([])
  })

  test('malformed bootstrap stays private and grants no begin frame', async ($, on) => {
    const frames: unknown[] = []
    on('process.run', async () => ({ value: { exitCode: 0, stdout: '{"enabled":true}', stderr: '' } }) as never)
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async (_$, e) => { frames.push(e.args); return { value: { content: [{ type: 'text', text: JSON.stringify({ sleightTurbo: { ...turboEnvelope, nonce: 'bad' } }) }] } } as never })
    on('prompt.submit', async (_$, e) => ({ text: e.text, context: e.context }))
    const result = await $.prompt.submit(genuinePrompt('allow TextEdit'))
    expect(frames).toEqual([{ sleight_turbo: { event: 'bootstrap' } }])
    expect(result).toEqual({ text: 'allow TextEdit', context: undefined })
  })

  test('failed turbo state still delivers genuine approval text with turbo off', async ($, on) => {
    const frames: Record<string, unknown>[] = []
    on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: 'unavailable' } }) as never)
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async (_$, e) => {
      frames.push(e.args)
      return { value: { content: [{ type: 'text', text: JSON.stringify({ sleightTurbo: turboEnvelope }) }] } } as never
    })
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    await $.prompt.submit(genuinePrompt('allow TextEdit'))
    expect(frames.length).toBe(2)
    expect((frames[1]!.sleight_turbo as { turbo: boolean }).turbo).toBe(false)
  })

  for (const turboBound of [true, false]) test(`a no-tool turn ends only bound turbo work: ${turboBound}`, async ($, on) => {
    const frames: Record<string, unknown>[] = []
    on('process.run', async () => ({ value: { exitCode: 0, stdout: '{"enabled":true}', stderr: '' } }) as never)
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async (_$, e) => {
      frames.push(e.args)
      return { value: { content: [{ type: 'text', text: JSON.stringify(
        (e.args.sleight_turbo as { event?: string })?.event === 'bootstrap' ? { sleightTurbo: turboEnvelope } : { sleightRemote: { turboBound } }) }] } } as never
    })
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    on('turn.start', async (_$, e) => ({ turnId: e.turnId }) as never)
    on('turn.complete', async () => ({ text: '' }) as never)
    await $.prompt.submit(genuinePrompt('Just answer a question'))
    await $.turn.start({ turnId: 'no-tools-turn' } as never)
    await $.turn.complete({ turnId: 'no-tools-turn', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
    expect(frames.filter(frame => frame.hook_event_name === 'Stop').length).toBe(turboBound ? 1 : 0)
  })

  test('a failed begin keeps the envelope for a new genuine turn and cannot expose its response as context', async ($, on) => {
    const frames: Record<string, unknown>[] = []
    let count = 0
    on('process.run', async () => ({ value: { exitCode: 0, stdout: '{"enabled":false}', stderr: '' } }) as never)
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async (_$, e) => {
      frames.push(e.args)
      const bootstrap = (e.args.sleight_turbo as { event?: string })?.event === 'bootstrap'
      return { value: { isError: !bootstrap && ++count === 1, content: [{ type: 'text', text: JSON.stringify(bootstrap ? { sleightTurbo: turboEnvelope }
        : { sleightRemote: { turboBound: false, context: 'arbitrary returned words' } }) }] } } as never
    })
    on('prompt.submit', async (_$, e) => ({ text: e.text, context: e.context }))
    for (const text of ['allow TextEdit', 'allow Mail']) expect((await $.prompt.submit(genuinePrompt(text))).context).toBeUndefined()
    expect(frames.filter(frame => (frame.sleight_turbo as { event?: string })?.event === 'bootstrap').length).toBe(1)
    expect(frames.length).toBe(3)
  })

  for (const filename of ['preapproved.json', 'turbo.json']) test(filename + ': PreToolUse denies each policy-file mutation and named Bash writes, preserving reads', async ($, on) => {
    const path = '/Users/fixture/Library/Application Support/sleight/' + filename
    mock.env(on, { HOME: '/Users/fixture' })
    on('fs.stat', async (_$, e) => ({ value: { kind: 'file', size: 2, mtimeMs: 0, isLink: false,
      realPath: e.path === '/fixture-alias' ? path : e.path } }) as never)
    on('tool.call', async () => ({ result: {} }) as never)
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      const result = await $.tool.call({ tool, file_path: path, notebook_path: path, content: '{}', old_string: 'a', new_string: 'b', new_source: '{}', edits: [] } as never)
      expect(String(result.deny ?? result.text)).toMatch(/only the user/i)
    }
    for (const command of [`tee "${path}"`, `cp source "${path}"`, `mv "${path}" backup`, `rm "${path}"`, `echo '{}' > "${path}"`,
      `ln -sf source "${path}"`, `bash -c 'rm "${path}"'`, `env -i truncate -s 0 "${path}"`,
      `python3 -c "p='${path}'; open(p, 'a').write('{}')"`]) {
      const result = await $.tool.call({ tool: 'Bash', command } as never)
      expect(String(result.deny ?? result.text)).toMatch(/only the user/i)
    }
    for (const alias of [path.toUpperCase(), '~/Library/Application Support/sleight/' + filename, '/fixture-alias']) {
      const result = await $.tool.call({ tool: 'Write', file_path: alias, content: '{}' } as never)
      expect(String(result.deny ?? result.text)).toMatch(/only the user/i)
    }
    for (const command of [`cat "${path}"`, `python3 -c "print(open('${path}').read())"`,
      `node -e "console.log(require('fs').readFileSync('${path}'))"`, `python3 script.py "${path}"`]) {
      const read = await $.tool.call({ tool: 'Bash', command } as never)
      expect(read.deny).toBeUndefined()
    }
  })

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
    await $.prompt.submit({ text: 'Continue the task', asUser: true } as never)
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
    const files = new Map<string, string>()
    on('session.id', async () => ({ value: 'session-test' }) as never)
    on('session.messages', async () => { throw new Error('The compacted conversation must not be used for recording.') })
    on('process.run', async (_$, e) => {
      recorderCalls.push(e.argv)
      if (e.argv[3]) files.set(e.argv[3], JSON.stringify(script))
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    })
    on('fs.exists', async () => ({ value: writes.length > 0 }) as never)
    on('fs.read', async (_$, e) => {
      const text = [...files].find(([name]) => e.path === name || e.path.endsWith(name) || name.endsWith(e.path))?.[1]
      if (text === undefined) throw new Error(`unexpected read ${e.path}`)
      return { value: text } as never
    })
    on('fs.write', async (_$, e) => { writes.push(e); return { value: undefined } })
    const first = await $.command.run({ command: 'sleight', args: 'record' } as never)
    expect(String((first as { text?: string }).text)).toMatch(/Recorded 2 steps/)
    expect(writes[0]!.path).toMatch(/\/sleight-session-test\.json$/)
    expect(JSON.parse(writes[0]!.text).steps[1].args.code).toBe('await app.click({"id":"Seven"});')
    expect((recorderCalls[0] as string[]).slice(1, 3)).toEqual(['record', 'session-test'])
    expect((recorderCalls[0] as string[])[3]).toMatch(/\.recording$/)
    const second = await $.command.run({ command: 'sleight', args: 'record' } as never)
    expect(String((second as { text?: string }).text)).toMatch(/already exists/)
    expect(writes.length).toBe(1)
  })

  test('recording a script over 4 MiB reads the recorder output file', async ($, on) => {
    const huge = { sleightReplay: 1, steps: [
      { tool: 'js', args: { code: 'let app = await cua.getApp("Calculator");', title: 'Acquire Calculator' } },
      { tool: 'js', args: { code: `await app.typeText(${JSON.stringify('x'.repeat(4 * 1024 * 1024))});`, title: 'Type' } },
    ] }
    const recorded = JSON.stringify(huge)
    expect(recorded.length).toBeGreaterThan(4 * 1024 * 1024)
    const writes: { path: string; text: string }[] = []
    const files = new Map<string, string>()
    on('session.id', async () => ({ value: 'session-test' }) as never)
    on('fs.exists', async () => ({ value: false }) as never)
    on('process.run', async (_$, e) => {
      const out = e.argv[3] ?? ''
      files.set(out, recorded)
      return { value: { exitCode: 0, stdout: '', stderr: 'sleight: 2 steps written to ' + out, isStdoutTruncated: true } } as never
    })
    on('fs.read', async (_$, e) => {
      const text = [...files].find(([name]) => e.path === name || e.path.endsWith(name) || name.endsWith(e.path))?.[1]
      if (text === undefined) throw new Error(`unexpected read ${e.path}`)
      return { value: text } as never
    })
    on('fs.write', async (_$, e) => { writes.push(e); return { value: undefined } })
    const result = await $.command.run({ command: 'sleight', args: 'record huge.json' } as never)
    expect(String((result as { text?: string }).text)).toMatch(/Recorded 2 steps/)
    expect(writes.length).toBe(1)
    expect(writes[0]!.path).toMatch(/\/huge\.json$/)
    expect(JSON.parse(writes[0]!.text).steps.length).toBe(2)
    expect(writes[0]!.text.length).toBeGreaterThan(4 * 1024 * 1024)
  })

  test('replay tool calls keep the normal check and obey Stop', async ($, on) => {
    on('tool.check', async () => ({ decision: 'ask', reason: 'core check' }) as never)
    on('tool.call', { tool: REPLAY_TOOL as never }, async () => ({ result: { content: [] } }) as never)
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
      if (e.tool === 'replay') return await new Promise<unknown>(resolve => { finish = resolve }) as never
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
    on('fs.read', async () => await new Promise<unknown>(resolve => { finish = resolve }) as never)
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
    on('fs.read', async () => await new Promise<unknown>(resolve => { finish = resolve }) as never)
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

  test('the pane names the latest turn receipt and shows its unsaved review', async ($, on) => {
    on('tool.call', { tool: JS_TOOL }, async () => ({ result: { content: [{ type: 'text', text: 'App: TextEdit.' }] } }) as never)
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async (_$, e) => ({ value: { content: [], ...(e.tool === 'turn_ended' ? {
      _meta: { 'sleight/receipt': { path: '/private/tmp/receipt with spaces.json', review: 'TextEdit: changed. Leave it as it is.' } },
    } : {}) } }) as never)
    await $.tool.call({ tool: JS_TOOL, code: 'await cua.getApp("TextEdit")' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { bodyColumns: 60 } as never })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /Latest receipt: \/private\/tmp\/receipt with spaces\.json/ })).toBeDefined()
    expect(await ui.find({ text: /TextEdit: changed\. Leave/ })).toBeDefined()
  })

  test('the pane reads receipt content when the host drops MCP result metadata', async ($, on) => {
    on('tool.call', { tool: JS_TOOL }, async () => ({ result: { content: [{ type: 'text', text: 'App: Calculator.' }] } }) as never)
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async (_$, e) => ({ value: { content: e.tool === 'turn_ended' ? [{ type: 'text',
      text: 'sleight-receipt: ' + JSON.stringify({ path: '/private/tmp/actual-host.json', review: 'Calculator: changed.' }) }] : [] } }) as never)
    await $.tool.call({ tool: JS_TOOL, code: 'await cua.getApp("Calculator")' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { bodyColumns: 60 } as never })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /Latest receipt: \/private\/tmp\/actual-host\.json/ })).toBeDefined()
    expect(await ui.find({ text: /Calculator: changed/ })).toBeDefined()
    expect(await ui.find({ key: 'replay' })).toBeDefined()
    expect(await ui.find({ key: 'record' })).toBeDefined()
  })

  test('the pane lets a before/after review wrap on both surfaces', async ($, on) => {
    const review = 'Window 1, TextEdit: changed.\ntext entry area 1, value: [redacted 16 chars] -> [redacted 17 chars]\nLeave it as it is.'
    on('tool.call', { tool: JS_TOOL }, async () => ({ result: { content: [] } }) as never)
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async (_$, e) => ({ value: { content: e.tool === 'turn_ended' ? [{ type: 'text',
      text: 'sleight-receipt: ' + JSON.stringify({ review }) }] : [] } }) as never)
    await $.tool.call({ tool: JS_TOOL, code: 'await cua.getApp("TextEdit")' } as never)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface, props: { bodyColumns: 40 } as never })
      await ui.press({ key: 'refresh' })
      const node = await ui.find({ type: 'Text', text: /text entry area 1, value:/ })
      expect(node).toBeDefined()
      expect((node as { props?: { wrap?: string } }).props?.wrap).not.toBe('truncate-end')
    }
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

  test('/sleight stop displays the checked engine receipt and an absent receipt stays unconfirmed', async ($, on) => {
    let text = 'sleight stop: in flight: js: Type. Engine cut off and collected; turn unconfirmed. Input leases released and checked.'
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async (_$, e) => {
      expect(e.args.sleight_stop).toBe(true)
      return { value: { content: [{ type: 'text', text }] } } as never
    })
    const receipt = await $.command.run({ command: 'sleight', args: 'stop' } as never)
    expect(String((receipt as { text?: string }).text)).toContain(text)
    // The stop usually ends the turn itself (the 2026-10-11 desktop check), so Esc is conditional.
    expect(String((receipt as { text?: string }).text)).toContain('If Claude keeps working, press Esc')
    text = 'old engine response'
    const absent = await $.command.run({ command: 'sleight', args: 'stop' } as never)
    expect(String((absent as { text?: string }).text)).toContain('no checked receipt')
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

  test('Refresh and the next prompt find an app acquired by window id', async ($, on) => {
    const windowScript = { sleightReplay: 1, steps: [
      { tool: 'js', args: { code: 'let app = await cua.getApp({ windowId: 11 });', title: 'Acquire by window' } },
      { tool: 'js', args: { code: 'await app.click({"id":"Seven"});', title: 'Press Seven' } },
    ] }
    const contexts: unknown[] = []
    const calls: unknown[] = []
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    on('fs.read', async () => ({ value: JSON.stringify(windowScript) }) as never)
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async (_$, e) => {
      calls.push(e)
      if (e.tool === 'replay') {
        return { value: { content: [{ type: 'text', text: JSON.stringify({
          ok: true, steps: 2, waits: [{ step: 1, waitedMs: 0 }, { step: 2, waitedMs: 0 }],
          window: 'Window: "Calculator", App: Calculator.\n0 standard window Calculator',
        }) }] } } as never
      }
      return { value: { content: [] } } as never
    })
    on('prompt.submit', async (_$, e) => { contexts.push(e.context); return { text: e.text } })
    const result = await $.command.run({ command: 'sleight', args: 'replay task.json' } as never)
    expect(String((result as { text?: string }).text)).toMatch(/Replay finished/)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { bodyColumns: 60 } as never })
    await ui.press({ key: 'refresh' })
    expect(calls.some((value: any) => value.tool === 'js' && String(value.args?.code ?? '').includes('const APP = "Calculator"'))).toBe(true)
    await $.prompt.submit({ text: 'Continue the task', asUser: true } as never)
    expect(JSON.stringify(contexts.at(-1))).toMatch(/Calculator.*disableDiffing/)
  })

  test('after a pane replay the next prompt asks Claude for a full read', async ($, on) => {
    const contexts: unknown[] = []
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    on('fs.read', async () => ({ value: JSON.stringify(script) }) as never)
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async () => ({ value: { content: [{ type: 'text', text: JSON.stringify({ ok: true, steps: 2, waits: [] }) }] } }) as never)
    on('prompt.submit', async (_$, e) => { contexts.push(e.context); return { text: e.text } })
    const result = await $.command.run({ command: 'sleight', args: 'replay task.json' } as never)
    expect(String((result as { text?: string }).text)).toMatch(/Replay finished/)
    await $.prompt.submit({ text: 'Continue the task', asUser: true } as never)
    expect(JSON.stringify(contexts.at(-1))).toMatch(/Calculator.*disableDiffing/)
  })

  test('a turn that used an app still ends the engine turn when the pane list fails', async ($, on) => {
    const calls: string[] = []
    on('tool.call', { tool: JS_TOOL }, async () => ({ result: { content: [{ type: 'text', text: 'App: Calculator.' }] } }) as never)
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async (_$, e) => { calls.push(e.tool); return { value: { content: [] } } as never })
    on('ui.panes', async () => { throw new Error('pane list unavailable') })
    on('turn.start', async (_$, e) => ({ turnId: e.turnId }) as never)
    on('turn.complete', async () => ({ text: '' }) as never)
    await $.turn.start({ turnId: 'turn-1' } as never)
    await $.tool.call({ tool: JS_TOOL, code: 'await cua.getApp("Calculator")' } as never)
    await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
    expect(calls).toEqual(['turn_ended'])
  })

  test('Claude may not call turn_ended', async $ => {
    const refused = await $.tool.call({ tool: TURN_END_TOOL } as never)
    expect(String(refused.deny)).toMatch(/internal to sleight/)
  })
  for (const name of ['browser_open', 'browser_read', 'browser_act', 'browser_fill']) {
    test(`${name} marks a browser-only turn for the fixed completion hook`, async ($, on) => {
      const calls: string[] = []
      const tool = `mcp__plugin_sleight_computer__${name}`
      on('tool.call', { tool: tool as never }, async () => ({ result: { content: [] } }) as never)
      on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
      on('mcp.call', async (_$, e) => { calls.push(e.tool); return { value: { content: [] } } as never })
      on('turn.start', async (_$, e) => ({ turnId: e.turnId }) as never)
      on('turn.complete', async () => ({ text: '' }) as never)
      await $.turn.start({ turnId: 'turbo-turn' } as never)
      await $.tool.call({ tool, tab: 't1', fields: [{ ref: 'r1', value: 'private fixture' }] } as never)
      await $.turn.complete({ turnId: 'turbo-turn', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
      expect(calls).toEqual(['turn_ended'])
    })
  }
  test('/sleight stop also refuses every compact browser tool', async ($, on) => {
    on('mcp.connect', async (_$, e) => ({ value: { isConnected: true, server: e.server } }) as never)
    on('mcp.call', async () => ({ value: { content: [] } }) as never)
    on('tool.call', async () => ({ result: { content: [] } }) as never)
    await $.command.run({ command: 'sleight', args: 'stop' } as never)
    for (const name of ['browser_open', 'browser_read', 'browser_act', 'browser_fill']) {
      const result = await $.tool.call({ tool: `mcp__plugin_sleight_computer__${name}`, tab: 't1' } as never)
      expect(String(result.deny)).toMatch(/stopped sleight/)
    }
  })
})

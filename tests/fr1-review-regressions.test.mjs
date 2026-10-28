import test from 'node:test';
import assert from 'node:assert/strict';
import { tokens, FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { clipboardActions } from '../plugins/sleight/lib/clipboard.mjs';
import { literalElements } from '../plugins/sleight/lib/literal-elements.mjs';
import { nativeArgumentsProblem } from '../plugins/sleight/lib/native-arguments.mjs';
import { nativeTabPlan } from '../plugins/sleight/lib/tab-probe.mjs';
import { shellLaunchDenied } from '../plugins/sleight/hooks/shell-guard.mjs';
import { narrationLine, assistantNarration } from '../plugins/sleight/hooks/narration.mjs';
import { splitMenuActions } from '../plugins/sleight/lib/menu-continuation.mjs';
import { splitTextSave } from '../plugins/sleight/lib/text-save.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';

const flow = () => new FlowRules({ version: 1, rules: [
  { id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] },
] });
const prefix = 'await app.typeText("SECRET"); await app.paste(); await app.paste(); await app.click(7); ';
test('the exact review suffix preserves each separate security check', () => {
  const suffix = " const ok = text && /'/.test(text);";
  assert.equal(flow().analyze('js', { code: 'await app.typeText("SECRET");' + suffix }, { app: 'Fixture' }).violations.length, 1);
  assert.deepEqual(clipboardActions('await app.paste(); await app.paste();' + suffix), ['paste', 'paste']);
  assert.deepEqual(literalElements('await app.click(7);' + suffix), [7]);
});
for (const suffix of ["const ok = text && /'/.test(text);",
  'if (c) /\'/.test(s);', '; /"/.test(s);', 'const ok = text || /\'/.test(text);',
  'const ok = text ?? /\'/.test(text);', 'const found = values.filter(l => /\'/.test(l));']) {
  test(`review regex preserves earlier actions: ${suffix}`, () => {
    const code = prefix + suffix;
    assert.equal(tokens(code).some(t => !t.string && t.v === '<invalid>'), false);
    assert.equal(flow().analyze('js', { code }, { app: 'Fixture' }).violations.length, 1);
    assert.deepEqual(clipboardActions(code), ['paste', 'paste']);
    assert.deepEqual(literalElements(code), [7]);
  });
}

for (const suffix of ['"unterminated', '"raw\nline"', '`${"`"}`', '/* unterminated',
  'const r = /unterminated', 'const r = /[\r]/']) {
  test(`an incomplete legacy scan preserves its prefix and statement splitting follows module validity: ${JSON.stringify(suffix)}`, () => {
    const code = prefix + suffix, ts = tokens(code);
    assert.equal(ts[0].v, 'await');
    assert.equal(ts.at(-1).v, '<invalid>');
    assert.equal(flow().analyze('js', { code }, { app: 'Fixture' }).violations.length, 1);
    assert.throws(() => clipboardActions(code), /cannot inspect JavaScript/i);
    assert.throws(() => literalElements(code), /cannot inspect JavaScript/i);
    assert.match(nativeArgumentsProblem(code), /cannot inspect JavaScript/i);
    assert.equal(splitMenuActions('await app.click(1); await app.click(2); ' + suffix), undefined);
    const saveCode = suffix + '; await app.setValue(1, "safe"); await app.pressKey("super+s")';
    if (suffix === '`${"`"}`') assert.deepEqual(splitTextSave(saveCode), {
      handle: 'app', head: suffix + '; await app.setValue(1, "safe");', tail: 'await app.pressKey("super+s")',
    });
    else assert.equal(splitTextSave(saveCode), undefined);
    const planCode = 'await app.typeText("https://example.test"); ' + suffix;
    assert.equal(nativeTabPlan({ code: planCode, actions: [
      { selector: { kind: 'key', value: 'super+t' } },
      { start: 0, end: planCode.length }, { selector: { kind: 'key', value: 'Return' } },
    ] }), false);
  });
}

test('relay refuses incomplete inspection before a prefix can dispatch through either code alias', async t => {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, sent = [], replies = [];
  serverIn.on('data', bytes => sent.push(JSON.parse(bytes)));
  clientOut.on('data', bytes => replies.push(JSON.parse(bytes)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, flowRules: flow(), changeReview: false });
  t.after(() => { relay.dispose(); streams.forEach(s => s.destroy()); });
  let id = 0;
  for (const key of ['code', 'command']) for (const code of [prefix + '`${"`"}`',
    'let other = await cua.getApp("Fixture"); await other.setValue(1, "safe"); await other.pressKey("super+s"); "unterminated']) {
    clientIn.write(JSON.stringify({ id: ++id, method: 'tools/call', params: { name: 'js', arguments: { [key]: code } } }) + '\n');
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 0);
  assert.equal(replies.length, 4);
  for (const reply of replies) {
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /cannot inspect JavaScript|JS \[\d+:\d+\]:/i);
    assert.doesNotMatch(reply.result.content[0].text, /SECRET|unterminated/);
  }
});

test('line refusal explains literal plus slash ambiguity without echoing caller text', async t => {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, sent = [], replies = [];
  serverIn.on('data', bytes => sent.push(JSON.parse(bytes)));
  clientOut.on('data', bytes => replies.push(JSON.parse(bytes)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => { relay.dispose(); streams.forEach(s => s.destroy()); });
  let id = 0;
  for (const end of ['\r', '\u2028', '\u2029']) for (const code of [
    `// c${end}await app.click(3)`,
    'await app.typeText("SECRET' + (end === '\r' ? '\\' : '') + end + 'VALUE"); const half = n / 2;',
    'await app.typeText(`SECRET' + end + 'VALUE`); const read = lines.filter(l => /Save/.test(l));',
    'let n = 1; nodeRepl.write(`SECRET' + end + 'VALUE`); n-->0;',
  ]) clientIn.write(JSON.stringify({ id: ++id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 0);
  assert.equal(replies.length, 12);
  for (const reply of replies) {
    const text = reply.result.content[0].text;
    assert.equal(reply.result.isError, true);
    assert.match(text, /outside strings\/templates/);
    assert.match(text, /ambiguous regex\/division, <!--\/--> or deep nesting/);
    assert.doesNotMatch(text, /SECRET|VALUE|Save/);
  }
});

test('division stays executable and regex contents never invent actions', () => {
  const code = 'const half = n / 2; const ratio = n / count / 2; await app.click(7);';
  assert.deepEqual(literalElements(code), [7]);
  for (const name of ['if', 'return', 'throw', 'await', 'case', 'yield', 'else', 'do']) {
    assert.deepEqual(literalElements(`const value = obj.${name} / app.click(7) / count;`), [7], name);
    assert.deepEqual(literalElements(`const value = obj.${name}(x) / app.click(7) / count;`), [7], name);
  }
  for (const suffix of ['const r = /app.paste()/;', 'text && /app.click(8)/.test(text);',
    'if (c) /app.typeText("SECRET")/.test(s);']) {
    assert.deepEqual(clipboardActions(suffix), []);
    assert.deepEqual(literalElements(suffix), []);
    assert.equal(flow().analyze('js', { code: suffix }, { app: 'Fixture' }).violations.length, 0);
  }
  assert.deepEqual(clipboardActions('nodeRepl.write("<invalid>")'), []);
  assert.deepEqual(splitTextSave('const r = /\';/; await app.setValue(1, "safe"); await app.pressKey("super+s");'), {
    handle: 'app', head: 'const r = /\';/; await app.setValue(1, "safe");', tail: 'await app.pressKey("super+s");',
  });
});

test('private and Unicode members remain division operands', async () => {
  for (const member of ['#await', '#if', 'αawait', 'αif']) {
    for (const [definition, operand] of [[`${member} = 1`, `this.${member}`], [`${member}() { return 1; }`, `this.${member}()`]]) {
      const code = `class Ratio { ${definition}; async run() { return ${operand} / await app.typeText("SECRET") / 2; } } await new Ratio().run();`;
      const typed = [];
      await runInNewContext('(async () => {' + code + '})()', { app: { typeText: async value => { typed.push(value); return 1; } } });
      assert.deepEqual(typed, ['SECRET']);
      assert.equal(flow().analyze('js', { code }, { app: 'Fixture' }).violations.length, 1, member);
    }
    const valueCode = `const value = this.${member} / app.click(7) / count;`;
    assert.deepEqual(literalElements(valueCode), [7], member);
  }
  const escaped = 'obj.\\u{03B1}if(x) / app.click(7) / count;';
  assert.match(nativeArgumentsProblem(escaped), /cannot inspect JavaScript/);
});

test('structural shell terminators never manufacture a headless exemption', () => {
  for (const end of ['\r', '\u2028', '\u2029']) {
    for (const command of [`chromium --headless${end}=false`, `chromium --headless${end}garbage`,
      `chromium '--headless${end}=false'`]) {
      assert.equal(shellLaunchDenied({ tool: 'Bash', command }), true, JSON.stringify(command));
    }
  }
});

const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
for (const [label, end] of [['LF', '\n'], ['CR', '\r'], ['LS', '\u2028'], ['PS', '\u2029']]) {
  test(`${label}: interpreter comments cannot hide a launcher`, () => {
    for (const [command, payload] of [
      ['node -e', `// c${end}require('child_process').execSync('open -a Safari')`],
      ['nodejs -e', `// c${end}require('child_process').execSync('open -a Safari')`],
      ['python3 -c', `# c${end}import os; os.system('open -a Safari')`],
      ['python3 -c', `import os as o${end}# c${end}o.system('open -a Safari')`],
      ['swift -e', `// c${end}let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/open"); p.arguments = ["-a", "Safari"]; try p.run()`],
      ['sh -c', `# c${end}open -a Safari`],
    ]) assert.equal(shellLaunchDenied({ tool: 'Bash', command: command + ' ' + shellQuote(payload) }), true, command);
    assert.equal(shellLaunchDenied({ tool: 'Bash', command: 'node -e ' + shellQuote(`// c${end}console.log("safe")`) }), false);
  });
  test(`${label}: narration sees calls and assignments after comments`, () => {
    assert.equal(narrationLine('Inspect the menu.', { code: `// c${end}await app.click(3)` }), 'Inspect the menu.');
    assert.equal(narrationLine('Inspect the menu.', { code: `// c${end}await unknown()` }), undefined);
    const messages = [{ role: 'assistant', content: [
      { type: 'tool_use', id: 'acquire', name: 'js', input: { code: 'let app = await cua.getApp("Fixture")' } },
      { type: 'tool_use', id: 'alias', name: 'js', input: { code: `// c${end}app.click = unknown` } },
      { type: 'text', text: 'Inspect the menu.' }, { type: 'tool_use', id: 'current', name: 'js' },
    ] }];
    assert.equal(assistantNarration(messages, 'current', { code: 'await app.click(3)' }), undefined);
  });
}

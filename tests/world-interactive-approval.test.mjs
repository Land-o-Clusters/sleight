// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
const MAC_USERS = ['', 'Users', ''].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { interactivePlan, interactiveAgentSetup, prepareInteractive, terminalGate, runInteractive } from '../bench/world/arms/claude-cu/interactive.mjs';
import { permissionDecision } from '../bench/world/arms/claude-cu/permission.mjs';
import { VirtualTerminal } from '../bench/world/arms/claude-cu/terminal.mjs';
import { getTasks } from '../bench/tasks.mjs';

const enabled = { cachedGrowthBookFeatures: { tengu_malort_pedway: { enabled: true } } };
function fixture(t, config = enabled) {
  const armDir = mkdtempSync(join(tmpdir(), 'sleight-cu-approval-')); t.after(() => removeTemp(armDir));
  const p = interactivePlan({ armDir, prompt: 'Read the fixture. Return RESULT ok.', allowedApps: ['Fixture Editor'], timeoutMs: 300 });
  if (config !== null) { mkdirSync(p.env.CLAUDE_CONFIG_DIR); writeFileSync(p.configFile, JSON.stringify(config)); }
  return p;
}
const card = (apps = ['Fixture Editor'], selected = 'deny') => '\nComputer Use wants to control these apps\n\n' +
  apps.map(app => `  ● ${app}`).join('\n') + '\n\n' +
  `${selected === 'deny' ? '❯' : ' '} Deny, and tell Claude what to do differently (esc)\n` +
  `${selected === 'allow' ? '❯' : ' '} Allow for this session (${apps.length} ${apps.length === 1 ? 'app' : 'apps'})\n`;

// The pinned card as the 14:39Z live run rendered it: words joined by cursor-forward codes, the request's reason in a box,
// a ◉ marker and the hidden-apps notice (2026-10-17).
const live = (selected = 'deny', app = 'Fixture Editor') => ['', 'Computer Use wants to control these apps', '', '',
  '   │ To edit the fixture by clicking its controls, then leave the result on screen.', '', '',
  '◉' + app.replaceAll(' ', '\x1b[1C').replace(/^/, '\x1b[1C'), '', '7\x1b[1Cother\x1b[1Capps\x1b[1Cwill\x1b[1Cbe\x1b[1Chidden\x1b[1Cwhile\x1b[1CClaude\x1b[1Cworks.', '', '',
  (selected === 'deny' ? '❯' : ' ') + 'Deny,\x1b[1Cand\x1b[1Ctell\x1b[1CClaude\x1b[1Cwhat\x1b[1Cto\x1b[1Cdo\x1b[1Cdifferently\x1b[1C(esc)', '',
  (selected === 'allow' ? '❯' : ' ') + 'Allow\x1b[1Cfor\x1b[1Cthis\x1b[1Csession\x1b[1C(1\x1b[1Capp)', '', '',
  'Enter\x1b[1Cto\x1b[1Cconfirm\x1b[1C·\x1b[1CEsc\x1b[1Cto\x1b[1Ccancel', ''].join('\n');

test('telemetry opt-out still loads the owner cached computer-use entitlement', () => {
  const p = interactivePlan({ armDir: `${MAC_TMP}/cu-env-fixture`, prompt: 'RESULT ok',
    hostEnv: { CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF: '0', ANTHROPIC_API_KEY: 'fixture' } });
  assert.equal(p.env.DISABLE_TELEMETRY, '1');
  assert.equal(p.env.DO_NOT_TRACK, '1');
  assert.equal(p.env.CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF, '1');
  assert.equal(p.env.ANTHROPIC_API_KEY, undefined);
});
for (const [name, config] of [['absent config', null], ['absent feature', {}], ['disabled', { cachedGrowthBookFeatures: { tengu_malort_pedway: { enabled: false } } }],
  ['truthy string', { cachedGrowthBookFeatures: { tengu_malort_pedway: { enabled: 'true' } } }]]) {
  test(`preparation refuses ${name} before writing trust or settings`, t => {
    const p = fixture(t, config), before = existsSync(p.configFile) && readFileSync(p.configFile, 'utf8');
    assert.throws(() => prepareInteractive(p), /cached.*computer.use.*enabled/i);
    assert.equal(existsSync(p.settingsFile), false);
    assert.equal(existsSync(p.cwd), false);
    assert.equal(existsSync(p.configFile) && readFileSync(p.configFile, 'utf8'), before);
  });
}
test('ready input accepts the pinned CLI placeholder but not typed input or an approval', () => {
  for (const input of ['❯ Try "refactor <filepath>"\n', '❯ Try"fix lint errors"\n', '\x1b[32m❯\x1b[0m Try "write a test"\n'])
    assert.equal(terminalGate(input).ready, true, input);
  for (const input of ['❯ Try "unfinished', '❯ typed task\n', '❯ Try "fix lint errors"\nAllow for this session'])
    assert.equal(terminalGate(input).ready, false, input);
});
test('task allowlist survives adapter and CLI serialization instead of inheriting the host', t => {
  const p = fixture(t);
  const setup = interactiveAgentSetup({ armDir: p.armDir, dir: p.cwd, prompt: p.prompt,
    task: { allowedApps: ['Fixture Editor', 'Fixture Viewer'] }, hostEnv: { BENCH_CU_ALLOWED_APPS: '["Other App"]' } });
  assert.equal(setup.env.BENCH_CU_ALLOWED_APPS, '["Fixture Editor","Fixture Viewer"]');
  assert.equal(setup.args[setup.args.indexOf('--allowed-apps') + 1], '["Fixture Editor","Fixture Viewer"]');
  const dry = spawnSync(process.execPath, [new URL('../bench/world/arms/claude-cu/interactive.mjs', import.meta.url).pathname,
    '--arm-dir', p.armDir, '--prompt', p.prompt, '--allowed-apps', '["Fixture Editor"]'], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout).plan.allowedApps, ['Fixture Editor']);
});
test('browser adapter selects only its task browser from the benchmark allowlist', () => {
  const setup = interactiveAgentSetup({ armDir: `${MAC_TMP}/cu-adapter-fixture`, dir: `${MAC_TMP}/cu-adapter-work`,
    prompt: 'RESULT ok', task: { browser: 'helium' } });
  assert.equal(setup.env.BENCH_CU_ALLOWED_APPS, '["Helium"]');
});
async function session(p, { screens = [card()], cancel = false, afterDown = card(['Fixture Editor'], 'allow'), accessReason } = {}) {
  const writes = [], events = []; let finish, output, answer, exitKeys = 0, timer, downs = 0;
  const closed = new Promise(resolve => { finish = resolve; });
  const controller = new AbortController();
  const result = await runInteractive(p, { prepare() {}, verify() {}, serverReady: () => true, pollMs: 1, signal: controller.signal, onEvent: event => events.push(event),
    transcript: { update() {}, summary: () => ({ answer, accessReason, calls: 1, modelCalls: 1, usage: {}, modelUsage: {} }) }, turnEnded: () => true,
    launch: (_p, callback) => {
      output = callback; queueMicrotask(() => output('\n❯ \n'));
      return { closed, write(value) {
        writes.push(value);
        if (value.startsWith('\x1b[200~')) {
          if (cancel) controller.abort();
          output(screens[0]);
          if (screens.length > 1) timer = setTimeout(() => output(screens[1]), 15);
        } else if (value === '\x1b[B\r') {
          downs++; const shown = Array.isArray(afterDown) ? afterDown.at(-1) : afterDown;
          if (Array.isArray(afterDown)) output(afterDown[0]);
          if (shown && /❯\s*Allow/.test(shown.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''))) { answer = 'RESULT ok'; output('\x1b[2J\x1b[H❯ Try "write a test"\n'); }
          else if (shown) output(shown);
        } else if (value === '\x1b[B') { downs++; if (Array.isArray(afterDown)) { output(afterDown[0]); timer = setTimeout(() => output(afterDown[1]), 20); } else if (afterDown !== null) output(afterDown); }
        // Accepting erases the card, as Claude Code's redraw does; the harness no longer clears its own copy of the screen.
        else if (value === '\r') { answer = 'RESULT ok'; output('\x1b[2J\x1b[H❯ Try "write a test"\n'); }
        else if (value === '\x04' && ++exitKeys === 2) finish({ code: 0, clean: true });
      }, async stop() { clearTimeout(timer); finish({ code: 130, clean: true }); } };
    } });
  return { result, writes, events, downs: () => downs };
}
function assertBlock(result, events, reason) {
  assert.equal(result.reason, reason);
  assert.equal(result.is_error, true);
  assert.equal(result.gateBlocked, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.approvalBlock?.reason, reason);
  assert.ok(result.approvalBlock.cardText.length);
  assert.deepEqual(events.find(event => event.type === 'approval_block'), { type: 'approval_block', ...result.approvalBlock });
}
test('a complete allowlisted card navigates from Deny and confirms only the selected session option', async t => {
  const p = fixture(t), { result, writes } = await session(p);
  assert.equal(result.is_error, false, result.reason);
  assert.deepEqual(writes, ['\x1b[200~' + p.prompt + '\x1b[201~\r', '\x1b[B\r', '\x04', '\x04']);
});
test('fragmented cards wait for the whole app list and both options before accepting', async t => {
  const p = fixture(t), full = card(['Fixture Editor'], 'allow'), split = full.indexOf('Allow for');
  const { result, writes } = await session(p, { screens: [full.slice(0, split), full.slice(split)] });
  assert.equal(result.is_error, false, result.reason);
  assert.equal(writes.filter(v => v === '\r').length, 1);
});
test('the pinned card supports requested clipboard flags and already granted task apps', async t => {
  const screen = card(['Fixture Editor'], 'allow').replace('  ● Fixture Editor',
    '  ✔ Fixture Editor (already granted)\n  ● Fixture Editor Two\n\nAlso requested:\n  · clipboardRead\n  · clipboardWrite\n  · systemKeyCombos');
  const p = fixture(t); p.allowedApps.push('Fixture Editor Two');
  p.allowedGrants = ['clipboardRead', 'clipboardWrite', 'systemKeyCombos'];
  const { result, writes } = await session(p, { screens: [screen] });
  assert.equal(result.is_error, false, result.reason);
  assert.equal(writes.filter(value => value === '\r').length, 1);
});
for (const [name, screen] of [['foreign app', card(['Fixture Editor', 'Other App'], 'allow')],
  ['substring app', card(['Fixture Editor Pro'], 'allow')], ['count mismatch', card().replace('(1 app)', '(2 apps)')],
  ['hidden apps', card().replace('  ● Fixture Editor', '  ● Fixture Editor\n  … +1 more app not shown, and not included in this grant.')],
  ['unknown option', card().replace('Allow for this session (1 app)', 'Always allow')],
  ['macOS gate', card() + 'Grant Accessibility and Screen Recording\n'], ['trust gate', card() + 'Trust this folder\n'],
  ['unmarked app', card().replace('  ● Fixture Editor', '  Fixture Editor')],
  ['foreign app below options', card(['Fixture Editor'], 'allow') + '  ● Other App\n'],
  ['unrelated approval', card(['Fixture Editor'], 'allow') + 'Do you want to proceed?\n'],
  ['unknown extra grant', card(['Fixture Editor'], 'allow').replace('  ● Fixture Editor', '  ● Fixture Editor\nAlso requested:\n  · fullControl')]]) {
  test(`${name} card receives no navigation or acceptance`, async t => {
    const { result, writes, events } = await session(fixture(t), { screens: [screen] });
    const reason = ['macOS gate', 'trust gate'].includes(name) ? 'approval required'
      : name === 'unknown option' ? 'unsupported or incomplete computer-use approval card'
      : ['hidden apps', 'unmarked app', 'unknown extra grant'].includes(name) ? 'unsupported computer-use approval card'
      : 'computer-use approval is outside the task allowlist or unsupported';
    assertBlock(result, events, reason);
    assert.equal(writes.length, 1);
  });
}

test('the live-rendered card (cursor-forward spacing, reason box, ◉ marker) is accepted for an allowlisted app', async t => {
  const { result, writes } = await session(fixture(t), { screens: [live()], afterDown: live('allow') });
  assert.equal(result.is_error, false, result.reason);
  assert.equal(writes[1], '\x1b[B\r');
});
// Verbatim from the 15:23Z live run's approval-block.json: some lines lose their spaces, the card ends on spaces, a ⏺ follows.
const seen = selected => '\nComputer Use wants to control these apps\n\n\n   │ I need to use Calculator to clear the input and compute 80 × 55 by clicking its buttons.\n  \n\n◉Calculator\n\n\n\n7otherappswillbehiddenwhileClaudeworks.\n\n\n\n' +
  (selected === 'allow' ? ' Deny,andtellClaudewhattododifferently(esc)\n\n❯Allowforthissession(1app)' : '❯Deny,andtellClaudewhattododifferently(esc)\n\nAllowforthissession(1app)') +
  '\n\n\n\n\n\nEntertoconfirm·Esctocancel\n\n   \n \n\n\n   \n⏺\n\n\n   ';
test('the card exactly as the 15:23Z live run rendered it is answered for an allowlisted app and refused otherwise', async t => {
  const p = fixture(t); p.allowedApps = ['Calculator'];
  const { result, writes } = await session(p, { screens: [seen('deny')], afterDown: seen('allow') });
  assert.equal(result.is_error, false, result.reason);
  assert.equal(writes[1], '\x1b[B\r');
  const other = fixture(t); other.allowedApps = ['Calculator Pro'];
  const refused = await session(other, { screens: [seen('deny')] });
  assertBlock(refused.result, refused.events, 'computer-use approval is outside the task allowlist or unsupported');
});
// A whole card drawn as 2.1.289 draws it (words split by cursor-forward moves, options at absolute columns, the cursor parked
// on the selected ❯), then the exact redraw it sent after Down: the rawTail in sitting-1017c/approval-block-cu4.json (2026-10-17).
const words = text => text.replaceAll(' ', '\x1b[1C');
const frame = (app = 'Calculator') => ['', ' ' + words('Computer Use wants to control these apps'), '',
  '\x1b[4G│\x1b[6G' + words('I need to use Calculator to compute 80 × 55 by clicking its buttons.'), '',
  '\x1b[4G\x1b[1m◉\x1b[22m\x1b[6G' + words(app), '', '\x1b[4G' + words('7 other apps will be hidden while Claude works.'), '',
  '\x1b[4G\x1b[38;5;153m❯\x1b[6G' + words('Deny, and tell Claude what to do differently') + '\x1b[1C\x1b[1m(esc)\x1b[22m\x1b[39m',
  '\x1b[6G' + words('Allow for this session (1 app)'), '', '\x1b[4G' + words('Enter to confirm · Esc to cancel'), '', ''].join('\r\n') +
  '\x1b[5A\x1b[3C';
const downTail = '\x1b[3D\x1b[5B\r\x1b[3C\x1b[5A \x1b[6GDeny, and tell Claude what to do differently \x1b[1m(esc)\r\x1b[3C\x1b[1B\x1b[22m' +
  '\x1b[38;5;153m❯\x1b[6GAllow for this session (1 app)\x1b[39m\r\n\n\n\n\x1b[3C\x1b[4A';
test('the live redraw after Down overwrites the card in place, and the whole updated card is confirmed', async t => {
  const p = fixture(t); p.allowedApps = ['Calculator'];
  const { result, writes } = await session(p, { screens: [frame()], afterDown: downTail });
  assert.equal(result.is_error, false, result.reason);
  assert.equal(writes[1], '\x1b[B\r');
  const term = new VirtualTerminal();
  term.write(frame()); term.write(downTail);
  const lines = term.render().split('\n');
  assert.ok(lines.includes('   ❯ Allow for this session (1 app)'), lines.join('\n'));
  assert.ok(lines.includes('     Deny, and tell Claude what to do differently (esc)'));
  assert.ok(lines.includes(' Computer Use wants to control these apps'));
});
test('the virtual terminal moves, erases, saves and wraps as a terminal does and draws nothing for other sequences', () => {
  const draw = (chunks, options) => { const term = new VirtualTerminal(options); for (const chunk of [chunks].flat()) term.write(chunk); return term.render(); };
  assert.equal(draw('abc\x1b[2;3Hx\x1b[1;2fy'), 'ayc\n  x\n');
  assert.equal(draw('abcdef\x1b[4G\x1b[K\nabcdef\x1b[3G\x1b[1K\nabcdef\x1b[2K!'), 'abc\n   def\n      !');
  assert.equal(draw('1\n2\n3\x1b[2;2H\x1b[J'), '1\n2');
  assert.equal(draw('1\n2\n3\x1b[2;1H\x1b[1J'), '\n\n3\n');
  assert.equal(draw('1\n2\x1b[2J'), '');
  assert.equal(draw('ab\x1b7\x1b[3;9Hc\x1b8d\x1b[s\x1b[2Ee\x1b[uf'), 'abdf\n\ne       c\n');
  assert.equal(draw('abcd\b\bX\r\x1b[2CY'), 'abYd\n');
  assert.equal(draw('abcdefg', { columns: 4 }), 'abcd\nefg');
  assert.equal(draw('a\nb\nc\nd', { rows: 3 }), 'b\nc\nd');
  assert.equal(draw('\x1b[?25l\x1b]0;title\x07\x1b[38;5;153mA\x1b(B\x1b[?2004h\x1b[39mB\x1b]8;;x\x1b\\C'), 'ABC');
  assert.equal(draw(['A\x1b[', '3', 'CB\x1b', '[1D!']), 'A   !');
  assert.equal(draw('中文x\x1b[1Gy'), 'y 文x\n');
  assert.equal(draw('typing'), 'typing', 'a line the cursor is still on has no newline yet');
  assert.equal(draw('typed\x1b[1G'), 'typed\n');
});
// From the Allow row (cursor parked at column 3): up five rows to the app row, rewrite it, back down.
// Down and Enter now go in one write, so no redraw can come between them. Claude Code draws a new card only after the shown
// one is answered, so the card validated before the write is the one answered; foreign-app cards never get a key (tests above).
// Live 15:47Z: the spinner line under the card changed before the Down redraw arrived, the harness read Deny as still selected
// and pressed Down again, which wrapped the selection back to Deny.
test('a frame that changes only the spinner after Down never sends Down twice', async t => {
  const spinner = card() + '⏺\n';
  const { result, writes } = await session(fixture(t), { screens: [card()], afterDown: [spinner, card(['Fixture Editor'], 'allow')] });
  assert.equal(result.is_error, false, result.reason);
  assert.equal(writes.filter(value => value === '\x1b[B\r').length, 1);
});
// Live 15:58Z: the reason line came through without its box; it matched the reason sent with request_access, which now suffices.
test('an unboxed reason line matching the request_access reason is accepted, any other unboxed line refused', async t => {
  const reason = 'To clear the Calculator input and compute 34 × 30 by clicking its buttons.';
  const cardWith = (line, selected = 'deny') => card(['Calculator'], selected).replace('  ● Calculator', `   ${line}\n  ● Calculator`);
  const p = fixture(t); p.allowedApps = ['Calculator'];
  const ok = await session(p, { screens: [cardWith(reason)], afterDown: cardWith(reason, 'allow'), accessReason: reason });
  assert.equal(ok.result.is_error, false, ok.result.reason);
  const bad = await session(p, { screens: [cardWith('Terminal')], accessReason: reason });
  assertBlock(bad.result, bad.events, 'unsupported computer-use approval card');
  const inside = await session(p, { screens: [cardWith('Terminal')], accessReason: 'Use Calculator, not Terminal.' });
  assertBlock(inside.result, inside.events, 'unsupported computer-use approval card');
});
// Live 16:07Z: the transcript didn't yet hold the request_access call when the card drew, so the hook records it for the harness.
test('the PreToolUse hook records an allowed request_access reason and apps for the harness', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-cu-access-')); t.after(() => removeTemp(dir));
  const env = { BENCH_CU_ALLOWED_APPS: '["Calculator"]', BENCH_CU_SESSION: 's', BENCH_CU_CWD: '/w', BENCH_CU_ACCESS_FILE: join(dir, 'a.json') };
  const input = { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/w', tool_name: 'mcp__computer-use__request_access', tool_input: { apps: ['Calculator'], reason: 'Do it.' } };
  assert.deepEqual(permissionDecision(input, env), {});
  assert.deepEqual(JSON.parse(readFileSync(env.BENCH_CU_ACCESS_FILE, 'utf8')), { reason: 'Do it.', apps: ['Calculator'] });
  const denied = { ...input, tool_input: { apps: ['Terminal'], reason: 'x' } }, other = join(dir, 'b.json');
  permissionDecision(denied, { ...env, BENCH_CU_ACCESS_FILE: other });
  assert.equal(existsSync(other), false);
});
test('the reason and apps the hook recorded admit an unboxed reason line; a card naming other apps is refused', async t => {
  const reason = 'Switch Calculator to Scientific mode, clear the input, and compute 21 × 21.';
  const cardWith = (selected = 'deny') => card(['Calculator'], selected).replace('  ● Calculator', `   ${reason}\n  ● Calculator`);
  const p = fixture(t); p.allowedApps = ['Calculator', 'TextEdit']; p.accessFile = join(p.armDir, 'access-test.json');
  writeFileSync(p.accessFile, JSON.stringify({ reason, apps: ['Calculator'] }));
  const ok = await session(p, { screens: [cardWith()], afterDown: cardWith('allow') });
  assert.equal(ok.result.is_error, false, ok.result.reason);
  writeFileSync(p.accessFile, JSON.stringify({ reason, apps: ['TextEdit'] }));
  const other = await session(p, { screens: [cardWith()] });
  assertBlock(other.result, other.events, 'computer-use approval is outside the task allowlist or unsupported');
});
test('the live-rendered card still refuses an app outside the allowlist, and an unboxed line above the apps', async t => {
  const foreign = await session(fixture(t), { screens: [live('deny', 'Other App')] });
  assertBlock(foreign.result, foreign.events, 'computer-use approval is outside the task allowlist or unsupported');
  const unboxed = live().replace('◉', '  Terminal\n◉');
  const above = await session(fixture(t), { screens: [unboxed] });
  assertBlock(above.result, above.events, 'unsupported computer-use approval card');
});

for (const line of ['  Terminal', '  Also: Terminal']) {
  test(`unrecognized pre-app row refuses unconditionally: ${line.trim()}`, async t => {
    const p = fixture(t); p.allowedApps = ['Calculator'];
    const screen = card(['Calculator'], 'allow').replace('  ● Calculator', line + '\n  ● Calculator');
    const { result, writes, events } = await session(p, { screens: [screen] });
    assertBlock(result, events, 'unsupported computer-use approval card');
    assert.equal(writes.length, 1);
  });
}
test('a blocked card records the card, not the session banner above it', async t => {
  const screen = 'Welcome back Ada Example · ada@example.com\n' + card(['Fixture Editor', 'Other App'], 'allow');
  const { result, events } = await session(fixture(t), { screens: [screen] });
  assertBlock(result, events, 'computer-use approval is outside the task allowlist or unsupported');
  assert.doesNotMatch(result.approvalBlock.cardText, /Ada|example\.com/);
  assert.match(result.approvalBlock.cardText, /Other App/);
});
for (const grant of ['clipboardRead', 'clipboardWrite', 'systemKeyCombos', 'shellAccess']) {
  test(`${grant} requires an explicit task grant`, async t => {
    const screen = card(['Fixture Editor'], 'allow').replace('  ● Fixture Editor', '  ● Fixture Editor\n' +
      (grant === 'shellAccess' ? '⚠ equivalent to shell access' : `Also requested:\n  · ${grant}`));
    const p = fixture(t), denied = await session(p, { screens: [screen] });
    assertBlock(denied.result, denied.events, 'computer-use approval grant is outside the task allowlist');
    assert.equal(denied.writes.length, 1);
    p.allowedGrants = [grant];
    const allowed = await session(p, { screens: [screen] });
    assert.equal(allowed.result.is_error, false, allowed.result.reason);
  });
}
for (const [name, screen] of [
  ['numbered options', card().replace('❯ Deny', '❯ 1. Deny').replace('  Allow', '  2. Allow')],
  ['redraw without options', card().slice(0, card().indexOf('❯')) + '\x1b[2J\x1b[H' + card().slice(0, card().indexOf('❯'))],
  ['no trailing newline', card(['Fixture Editor'], 'allow').trimEnd()],
  ['quoted title', `The model said "Computer Use wants to control these apps"\n  ${MAC_USERS}owner/private.txt\n`],
  ['settings app before options', '\nComputer Use wants to control these apps\n  ● System Settings\n'],
]) {
  test(`${name} ends as a recorded block rather than a task timeout`, async t => {
    const { result, writes, events } = await session(fixture(t), { screens: [screen] });
    assertBlock(result, events, 'unsupported or incomplete computer-use approval card');
    assert.equal(writes.length, 1);
    assert.doesNotMatch(result.approvalBlock.cardText, /\/Users\/owner/);
    if (name === 'quoted title') assert.match(result.approvalBlock.cardText, /~\/private.txt/);
  });
}
for (const afterDown of [null, card()]) {
  test(`navigation waits for a different fresh render: ${afterDown === null ? 'no redraw' : 'identical redraw'}`, async t => {
    const { result, writes, events } = await session(fixture(t), { afterDown });
    assertBlock(result, events, 'computer-use approval did not render a fresh selection');
    assert.equal(writes.filter(value => value === '\x1b[B\r').length, 1);
  });
}

test('task fixture identities and explicit grants survive adapter, CLI and hooks without prompt lookup', t => {
  const p = fixture(t), task = getTasks('world').find(task => task.id === 'textedit-calculator');
  const setup = interactiveAgentSetup({ armDir: p.armDir, dir: p.cwd, prompt: 'Read in Terminal. RESULT ok',
    task: { ...task, allowedGrants: ['clipboardRead', 'clipboardWrite'] } });
  assert.deepEqual(JSON.parse(setup.env.BENCH_CU_ALLOWED_APPS), ['TextEdit', 'com.apple.TextEdit', 'Calculator', 'com.apple.calculator']);
  assert.deepEqual(JSON.parse(setup.env.BENCH_CU_ALLOWED_GRANTS), ['clipboardRead', 'clipboardWrite']);
  const dry = spawnSync(process.execPath, setup.args.filter(value => !['--run', '--parent-lock'].includes(value)), { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout).plan;
  assert.deepEqual(plan.allowedApps, ['TextEdit', 'com.apple.TextEdit', 'Calculator', 'com.apple.calculator']);
  assert.deepEqual(plan.allowedGrants, ['clipboardRead', 'clipboardWrite']);
  for (const app of ['TextEdit', 'com.apple.TextEdit', 'Calculator', 'com.apple.calculator']) {
    const output = permissionDecision({ hook_event_name: 'PermissionRequest', session_id: plan.sessionId, cwd: plan.cwd,
      tool_name: 'mcp__computer-use__app_click', tool_input: { app, x: 1, y: 2 } }, plan.env);
    assert.equal(output.hookSpecificOutput.decision.behavior, 'allow', app);
  }
  for (const id of ['calculator-click', 'finder-move', 'preview-read', 'word-edit', 'excel-edit', 'local-wikipedia']) {
    const fixtureTask = getTasks('world').find(task => task.id === id);
    assert.ok(fixtureTask.allowedApps.includes(fixtureTask.app), id);
    assert.ok(fixtureTask.allowedApps.some(app => /^(?:com\.|net\.)/.test(app)), id);
    assert.equal(fixtureTask.allowedApps.includes('Terminal'), false);
  }
});

for (const event of ['PermissionRequest', 'PreToolUse']) {
  test(`${event} denies unknown and teaching tools and checks every apps array and nested app batch`, async t => {
    const p = fixture(t); p.env.BENCH_CU_ALLOWED_APPS = '["Fixture Editor","com.fixture.Editor"]';
    const decision = (tool, tool_input) => permissionDecision({ hook_event_name: event, session_id: p.sessionId, cwd: p.cwd,
      tool_name: 'mcp__computer-use__' + tool, tool_input }, p.env).hookSpecificOutput;
    const behavior = output => output?.decision?.behavior ?? output?.permissionDecision;
    const denied = [ ['request_teach_access', { apps: ['Terminal'] }], ['request_teach_access', { apps: ['Fixture Editor'] }],
      ['request_full_control', {}], ['unknown_tool', {}],
      ['screenshot', { apps: ['Terminal'] }], ['screenshot', { apps: 'Fixture Editor' }],
      ['app_click', {}], ['app_batch', { app: 'com.fixture.Editor', actions: [{ action: 'click', app: 'Terminal' }] }],
      ['app_batch', { app: 'com.fixture.Editor', actions: [{ action: 'click', apps: ['Terminal'] }] }],
      ['computer_batch', { actions: [{ action: 'app_batch', app: 'com.fixture.Editor', actions: [{ action: 'request_full_control' }] }] }],
      ['request_access', { apps: ['Fixture Editor'], clipboardRead: true }],
    ];
    for (const [tool, input] of denied) {
      await t.test(JSON.stringify([tool, input]), () => {
        const output = decision(tool, input);
        assert.equal(behavior(output), 'deny');
        assert.match(output.decision?.message ?? output.permissionDecisionReason, /outside the task allowlist/);
      });
    }
    for (const [tool, input] of [ ['app_click', { app: 'com.fixture.Editor' }],
      ['app_batch', { app: 'com.fixture.Editor', actions: [{ action: 'click', x: 1, y: 2 }] }],
      ['computer_batch', { actions: [{ action: 'app_batch', app: 'com.fixture.Editor', actions: [{ action: 'click' }] }] }],
    ]) assert.equal(behavior(decision(tool, input)), event === 'PermissionRequest' ? 'allow' : undefined, tool);
    const unbound = permissionDecision({ hook_event_name: event, tool_name: 'mcp__computer-use__screenshot', tool_input: {} },
      { BENCH_CU_ALLOWED_APPS: '["Fixture Editor"]' }).hookSpecificOutput;
    assert.equal(behavior(unbound), 'deny', 'missing session and cwd must not match missing binding values');
    p.env.BENCH_CU_ALLOWED_GRANTS = '["clipboardRead"]';
    assert.equal(behavior(decision('request_access', { apps: ['Fixture Editor'], clipboardRead: true })), event === 'PermissionRequest' ? 'allow' : undefined);
  });
}

test('permission hook malformed stdin fails closed with exit 2 and a deny reason', () => {
  const result = spawnSync(process.execPath, [new URL('../bench/world/arms/claude-cu/permission.mjs', import.meta.url).pathname],
    { input: '{', encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /denied.*malformed/i);
  assert.equal(result.stdout, '');
});

for (const [name, input] of [['oversized stdin', ' '.repeat(65537)], ['non-object stdin', 'null'], ['unknown hook event', '{}']]) {
  test(`permission hook ${name} fails closed`, () => {
    const result = spawnSync(process.execPath, [new URL('../bench/world/arms/claude-cu/permission.mjs', import.meta.url).pathname],
      { input, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /denied/i);
    assert.equal(result.stdout, '');
  });
}
test('permission hook stdin timeout fails closed before the outer hook deadline', async t => {
  const child = spawn(process.execPath, [new URL('../bench/world/arms/claude-cu/permission.mjs', import.meta.url).pathname],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', stdout = '';
  child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.on('data', chunk => { stdout += chunk; });
  child.stdin.write('{');
  const deadline = setTimeout(() => child.stdin.end(), 4500); t.after(() => clearTimeout(deadline));
  const status = await new Promise(resolve => child.on('close', resolve));
  assert.equal(status, 2);
  assert.match(stderr, /denied.*timeout/i);
  assert.equal(stdout, '');
});
for (const failure of ['throw new Error("fixture crash")', 'Promise.reject(new Error("fixture rejection"))']) {
  test(`permission hook runtime failure denies: ${failure}`, () => {
    const path = new URL('../bench/world/arms/claude-cu/permission.mjs', import.meta.url);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `process.argv[1] = ${JSON.stringify(path.pathname)}; await import(${JSON.stringify(path.href)}); ${failure};`],
    { input: '', encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /denied.*hook failure/i);
    assert.equal(result.stdout, '');
  });
}
test('cancellation takes precedence over an otherwise allowed card', async t => {
  const { result, writes } = await session(fixture(t), { cancel: true });
  assert.equal(result.reason, 'cancelled'); assert.equal(writes.length, 1);
});
test('prepared permission hook allows only bound computer-use calls within the task allowlist', t => {
  const p = fixture(t); prepareInteractive(p);
  const settings = JSON.parse(readFileSync(p.settingsFile, 'utf8'));
  assert.ok(settings.hooks.PermissionRequest?.length, 'computer-use permission hook is installed');
  const command = settings.hooks.PermissionRequest[0].hooks[0].command;
  const invoke = (tool, input, extra = {}) => {
    const result = spawnSync(command, { shell: true, input: JSON.stringify({ hook_event_name: 'PermissionRequest',
      session_id: p.sessionId, cwd: p.cwd, tool_name: tool, tool_input: input, ...extra }), env: p.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).hookSpecificOutput.decision.behavior;
  };
  assert.equal(invoke('mcp__computer-use__request_access', { apps: ['Fixture Editor'] }), 'allow');
  // The pinned tool schema requires `reason` (2026-10-17 review).
  assert.equal(invoke('mcp__computer-use__request_access', { apps: ['Fixture Editor'], reason: 'Edit the fixture' }), 'allow');
  assert.equal(invoke('mcp__computer-use__request_access', { apps: ['Fixture Editor'], reason: 5 }), 'deny');
  assert.equal(invoke('mcp__computer-use__screenshot', {}), 'allow');
  // The pinned 2.1.289 tool and action names (live 15:40Z: every one was denied under guessed names).
  for (const [tool, input] of [['left_click', { coordinate: [10, 20] }], ['double_click', { coordinate: [1, 2] }], ['type', { text: 'x' }],
    ['key', { text: 'Return' }], ['zoom', { region: [0, 0, 10, 10] }], ['list_granted_applications', {}], ['mouse_move', { coordinate: [1, 2] }],
    ['computer_batch', { actions: [{ action: 'left_click', coordinate: [1, 2] }, { action: 'type', text: '4' }, { action: 'key', text: 'Return' }] }],
    ['app_ax_find', { app: 'Fixture Editor', query: 'x' }], ['app_list_windows', { app: 'Fixture Editor' }]])
    assert.equal(invoke('mcp__computer-use__' + tool, input), 'allow', tool);
  for (const tool of ['request_full_control', 'request_teach_access', 'teach_step', 'read_clipboard'])
    assert.equal(invoke('mcp__computer-use__' + tool, {}), 'deny', tool);
  assert.equal(invoke('mcp__computer-use__open_application', { app: 'Fixture Editor' }), 'allow');
  for (const input of [{ apps: ['Other App'] }, { apps: ['Fixture Editor', 'Other App'] }, { apps: [] }, {}, { apps: 'Fixture Editor' }])
    assert.equal(invoke('mcp__computer-use__request_access', input), 'deny');
  assert.equal(invoke('mcp__computer-use__open_application', { bundle_id: 'com.other.App' }), 'deny');
  assert.equal(invoke('Bash', { command: 'anything' }), 'deny');
  assert.equal(invoke('mcp__computer-use__screenshot', {}, { session_id: 'foreign' }), 'deny');
});
for (const event of ['PermissionRequest', 'PreToolUse']) {
  test(`${event} checks batch targets, cwd and malformed or empty allowlists`, t => {
    const p = fixture(t), input = { hook_event_name: event, session_id: p.sessionId, cwd: p.cwd,
      tool_name: 'mcp__computer-use__computer_batch', tool_input: { actions: [{ action: 'open_application', app: 'Fixture Editor' }] } };
    const behavior = (value, env = p.env) => {
      const output = permissionDecision(value, env).hookSpecificOutput;
      return output?.decision?.behavior ?? output?.permissionDecision;
    };
    assert.equal(behavior(input), event === 'PermissionRequest' ? 'allow' : undefined);
    for (const denied of [{ ...input, cwd: `${MAC_TMP}/foreign` },
      { ...input, tool_input: { actions: [{ action: 'open_application', app: 'Other App' }] } },
      { ...input, tool_input: { actions: [{ action: 'app_click', bundle_id: 'com.other.App' }] } }])
      assert.equal(behavior(denied), 'deny');
    for (const list of ['[', '[]', '[42]', '[" Fixture Editor"]'])
      assert.equal(behavior(input, { ...p.env, BENCH_CU_ALLOWED_APPS: list }), 'deny');
  });
}

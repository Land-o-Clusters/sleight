import { macIdentityDiagnostics } from '../plugins/sleight/lib/repl/identity-steps.mjs';
import { turboStartupNotices } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { macFocusDiagnostics } from '../plugins/sleight/lib/repl/focus-steps.mjs';
import { stopNoticeInventory } from '../plugins/sleight/hooks/stop-notice.mjs';
import { shellGuardReason } from '../plugins/sleight/hooks/shell-guard.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { skillRules, localToolDefinitions } from '../plugins/sleight/lib/launch.mjs';
import { batchingDescription, createRelay, promptNotice } from '../plugins/sleight/lib/relay.mjs';
import { compactJsDescription } from '../plugins/sleight/lib/tool-description.mjs';
import { FIRST_WINDOW_RULE, FIRST_WINDOW_LEAN_RULE } from '../plugins/sleight/lib/engine-app-docs.mjs';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';
import { WINDOWS_REPL_DOCS, windowsReplTools } from '../plugins/sleight/lib/windows-repl/docs.mjs';
import { WINDOWS_SAFETY_UNAVAILABLE, WINDOWS_REPL_NODE_UNSUPPORTED } from '../plugins/sleight/lib/windows-repl/client.mjs';
import { WINDOWS_FORBIDDEN_NOTICES } from '../plugins/sleight/lib/blocked-apps-windows.mjs';
import { WINDOWS_STUCK_ESCAPE_NOTE } from '../plugins/sleight/lib/windows-driver/safety.mjs';
import { WINDOWS_ESCAPE_SESSION_NOTICE, WINDOWS_TURN_END_FAILURE } from '../plugins/sleight/lib/driver-safety.mjs';
import { SCROLL_LOOP_NOTE, TEXTLESS_NOTE } from '../plugins/sleight/lib/compact-reads.mjs';
import { browserTools, closedTabOutcome, unknownTabOutcome, popupObservationHeader } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { handoffMessages } from '../plugins/sleight/lib/direct-browser/handoff.mjs';
import { closedSubmitWarning, shortStepOutcomes } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { guardUnavailableReason, guardPathReason } from '../plugins/sleight/hooks/preapproved-write-guard.mjs';
import { turboFirstRules } from '../plugins/sleight/lib/turbo-first-rules.mjs';
import { nativeArgumentError } from '../plugins/sleight/lib/native-arguments.mjs';
import { QUIT_KEY_REFUSAL } from '../plugins/sleight/lib/quit-key.mjs';
import { pendingTabNote } from '../plugins/sleight/lib/browser-turn-input.mjs';
import { MAC_DRIVER_READ_NOTICES } from '../plugins/sleight/lib/mac-driver/protocol.mjs';
import { PERSON_WAIT_NOTICE, PERSON_POINTER_NOTICE, MAC_DRIVER_TARGET_NOTICES, MAC_DRIVER_PARAM_NOTICE } from '../plugins/sleight/lib/mac-driver/errors.mjs';
import { ownRuntimeNotices, ownRuntimeStopNotices, ownRuntimeMenuNotices, ownRuntimeLedgerNotices, ownRuntimeReadRefusals } from '../plugins/sleight/lib/runtime-select.mjs';
import { MAC_DRIVER_ERRORS, MAC_DRIVER_NEXT, MAC_KEYBOARD_RECOVERY, macDriverStopNotices, GLIDE_STOP_SESSION_NOTICE, GLIDE_INTERRUPT_NOTICE } from '../plugins/sleight/lib/mac-driver/errors.mjs';
import { STRICT_TEXT_REFUSAL } from '../plugins/sleight/lib/mac-driver/preserve.mjs';
import { MAC_SAFETY_NOTICES } from '../plugins/sleight/lib/mac-safety.mjs';
import { SETTINGS_BUILD_POLICY, settingsSealNote } from '../plugins/sleight/lib/sealed-settings.mjs';
import { PREAPPROVED_PROBLEM_NOTICE, PREAPPROVED_DUPLICATE_NOTICE } from '../plugins/sleight/lib/preapproved.mjs';
import * as localToolPolicy from '../plugins/sleight/lib/local-tool-policy.mjs';
import { MAC_PREPARING_NOTICE, MAC_COMPILE_BACKOFF_NOTICE } from '../plugins/sleight/lib/mac-driver/input-registrar.mjs';
import { siteConsentQuestion } from '../plugins/sleight/lib/engine-site-consent.mjs';
// The budget script parses relay.mjs with the typescript dev dependency, which CI doesn't install.
import { packageSkip } from './requirements.mjs';
const budget = packageSkip('typescript') ? null : await import('../bench/prompt-budget.mjs');
const skip = !budget && 'needs the typescript dev dependency (npm install)';
const { noticeInventory, sharedNoticeInventory, taggedNoticeInventory, hookNoticeInventory } = budget ?? {};
const ts = budget && (await import('typescript')).default;

function requireSealedSettingsNotice(policy, inventory) {
  if (!policy.enforce) return;
  const text = settingsSealNote({ file: 'preapproved.json', state: 'unsealed' }, policy)
    .replace('preapproved.json', '<value>').replace('unsealed', '<value>');
  assert.ok(inventory.some(row => row.path.startsWith('sealed-settings.mjs:') && row.text === text),
    'enforced settings require the I4 line in the budgeted notice inventory');
  assert.match(policy.team ?? '', /^[A-Z0-9]{10}$/, 'enforced settings require a pinned signing Team');
}
test('sealed settings enforcement requires a budgeted I4 line in default and lean', { skip }, () => {
  for (const prompt of [undefined, 'lean']) requireSealedSettingsNotice(SETTINGS_BUILD_POLICY, taggedNoticeInventory(prompt));
});
test('the I4 budget gate rejects activation without the notice or signing Team', { skip }, () => {
  const policy = { enforce: true, team: 'ABCDEFGHIJ' };
  assert.throws(() => requireSealedSettingsNotice(policy, []), /I4 line/);
  const text = settingsSealNote({ file: 'preapproved.json', state: 'unsealed' }, policy)
    .replace('preapproved.json', '<value>').replace('unsealed', '<value>');
  const inventory = [{ path: 'sealed-settings.mjs:1', text }];
  assert.doesNotThrow(() => requireSealedSettingsNotice(policy, inventory));
  assert.throws(() => requireSealedSettingsNotice({ ...policy, team: null }, inventory), /signing Team/);
});

const firstRule = 'execute exactly one of the API calls shown below, optionally assigning its result to a variable. Do not add other API calls, waits, or snapshots to that invocation.';
const hash = text => createHash('sha256').update(text).digest('hex');
const baseline = JSON.parse(readFileSync(new URL('fixtures/prompt-default.json', import.meta.url)));
test('044e3606 configured session instruction snapshots retain the original prompt hashes', () => {
  const pinned = JSON.parse(readFileSync(new URL('fixtures/turbo-instructions-044e3606.json', import.meta.url)));
  assert.equal(hash(pinned.off), baseline.skill);
  assert.equal(hash(pinned.on), baseline.browserFullRules);
  assert.equal(hash(turboFirstRules(pinned.on)), baseline.browserFirstRules);
});
test('turbo preparation and startup failure have conditional notice pins', () => {
  const notices = turboStartupNotices();
  assert.equal(hash(JSON.stringify(notices)), baseline.turboStartupNotices);
  assert.ok(Buffer.byteLength(notices.join('\n')) < 260);
  assert.ok(notices.every(line => !skillRules().includes(line)));
});
test('Glide preparation progress is conditional, pinned and bounded', () => {
  assert.equal(hash(MAC_PREPARING_NOTICE), baseline.macPreparingNotice);
  assert.ok(Buffer.byteLength(MAC_PREPARING_NOTICE) <= 130);
  assert.ok(!ownRuntimeNotices().includes(MAC_PREPARING_NOTICE));
  assert.equal(hash(MAC_COMPILE_BACKOFF_NOTICE), baseline.macCompileBackoffNotice);
  assert.ok(Buffer.byteLength(MAC_COMPILE_BACKOFF_NOTICE) <= 130);
  assert.ok(!ownRuntimeNotices().includes(MAC_COMPILE_BACKOFF_NOTICE));
});
test('Glide identity diagnostics have a conditional pin and a 32 byte per-error ceiling', () => {
  const diagnostics = macIdentityDiagnostics();
  assert.equal(hash(JSON.stringify(diagnostics)), baseline.macIdentityDiagnostics);
  assert.ok(diagnostics.every(value => Buffer.byteLength(value) <= 32));
  assert.ok(!ownRuntimeNotices().some(value => diagnostics.includes(value)));
});
test('Glide focus diagnostics retain fixed steps within a conditional 32 byte per-error ceiling', () => {
  const diagnostics = macFocusDiagnostics().map(value => ' step=' + value.split('step=')[1] + ';');
  assert.equal(hash(JSON.stringify(diagnostics)), baseline.macFocusDiagnostics);
  assert.ok(diagnostics.every(value => Buffer.byteLength(value) <= 32));
});
test('GLS4 fixed focus and read refusal recovery has conditional pins and no startup text', () => {
  const focus = Object.values(MAC_KEYBOARD_RECOVERY), read = ownRuntimeReadRefusals();
  assert.equal(hash(JSON.stringify(focus)), baseline.macKeyboardRecovery);
  assert.equal(hash(JSON.stringify(read)), baseline.macReadRefusals);
  assert.ok(focus.every(value => Buffer.byteLength(value) <= 110));
  assert.ok(read.every(value => Buffer.byteLength(value) <= 180));
  assert.ok([...focus, ...read].every(value => !ownRuntimeNotices().includes(value)));
});
test('SA1C invalid local arguments have one conditional notice and no startup text', () => {
  assert.equal(typeof localToolPolicy.LOCAL_TOOL_ARGUMENT_NOTICE, 'string');
  assert.equal(hash(localToolPolicy.LOCAL_TOOL_ARGUMENT_NOTICE), baseline.localToolArgumentNotice);
  assert.ok(Buffer.byteLength(localToolPolicy.LOCAL_TOOL_ARGUMENT_NOTICE) <= 80);
  assert.ok(!JSON.stringify(localToolDefinitions({})).includes(localToolPolicy.LOCAL_TOOL_ARGUMENT_NOTICE));
});
test('Windows Escape session refusal has a conditional pin and a 100 byte ceiling', () => {
  assert.equal(hash(WINDOWS_ESCAPE_SESSION_NOTICE), baseline.windowsEscapeSessionNotice);
  assert.ok(Buffer.byteLength(WINDOWS_ESCAPE_SESSION_NOTICE) <= 100);
});
test('UC2B wait receipts have a separate conditional pin and add no startup text', () => {
  assert.equal(hash(JSON.stringify([PERSON_WAIT_NOTICE, PERSON_POINTER_NOTICE])), baseline.personWaitNotices);
  assert.ok(Buffer.byteLength(PERSON_WAIT_NOTICE + PERSON_POINTER_NOTICE) < 90);
  assert.ok(!ownRuntimeNotices().includes(PERSON_WAIT_NOTICE));
});
const preapprovedNotices = [PREAPPROVED_PROBLEM_NOTICE, PREAPPROVED_DUPLICATE_NOTICE];
const siteConsentNotice = siteConsentQuestion({ app: '<app>', title: '<title>' });
test('SA2R site consent is conditional, pinned and bounded with no startup text', () => {
  assert.equal(hash(siteConsentNotice), baseline.siteConsentQuestion);
  assert.ok(Buffer.byteLength(siteConsentNotice) <= 350);
  assert.ok(!JSON.stringify(localToolDefinitions({})).includes(siteConsentNotice));
});
test('approval recovery has a conditional notice pin and adds zero text to healthy sessions', () => {
  assert.equal(hash(JSON.stringify(preapprovedNotices)), baseline.preapprovedNotices);
  assert.ok(preapprovedNotices.every(text => text.length <= 200));
  assert.ok(preapprovedNotices.every(text => text.includes('~/Library/Application Support/sleight/preapproved.json')));
  // These are mutually exclusive, once per session, on a tool result. Ordinary default and lean totals stay fixed.
  assert.ok(Math.max(...preapprovedNotices.map(text => text.length)) <= 200);
});
test('conditional Stop faults and release guidance have pinned bounded inventories', () => {
  const errors = JSON.stringify({ errors: MAC_DRIVER_ERRORS, next: MAC_DRIVER_NEXT, interrupt: GLIDE_INTERRUPT_NOTICE, stop: stopNoticeInventory(), params: MAC_DRIVER_PARAM_NOTICE });
  assert.equal(hash(errors), baseline.macDriverErrorNotices);
  assert.ok(Buffer.byteLength(errors) <= 9000);
  assert.equal(hash(JSON.stringify(macDriverStopNotices())), baseline.macDriverStopNotices);
  assert.ok(Buffer.byteLength(macDriverStopNotices().join('\n')) <= 100);
});
test('the session Stop refusal has a separate conditional pin and adds no startup text', () => {
  assert.equal(hash(GLIDE_STOP_SESSION_NOTICE), baseline.glideStopSessionNotice);
  assert.ok(Buffer.byteLength(GLIDE_STOP_SESSION_NOTICE) <= 100);
  assert.ok(!ownRuntimeNotices().includes(GLIDE_STOP_SESSION_NOTICE));
  if (budget) assert.ok(!noticeInventory().some(row => row.text.includes(GLIDE_STOP_SESSION_NOTICE)));
});
test('enforced settings advice has its own notice pin and differs from preview', () => {
  const row = { file: 'preapproved.json', state: 'unsealed' };
  const enforced = settingsSealNote(row, { enforce: true });
  assert.equal(hash(enforced), baseline.sealedSettingsNotice);
  assert.notEqual(enforced, settingsSealNote(row, { enforce: false }));
  assert.doesNotMatch(enforced, /adoption comes/);
});
const appPolicyNotices = Object.values(JSON.parse(readFileSync(new URL('../plugins/sleight/lib/app-policy/categories.json', import.meta.url))))
  .flatMap(({ sentence, overrideSentence, cardRisk }) => [sentence, ...overrideSentence ? [overrideSentence] : [], cardRisk]);
test('runtime app policy wording has a separate conditional pin and adds no startup text', () => {
  assert.equal(hash(JSON.stringify(appPolicyNotices)), baseline.macAppPolicyNotices);
  assert.equal(appPolicyNotices.length, 17);
  assert.ok(appPolicyNotices.every(text => text.length < 250));
});
test('own runtime notices have a separate pin and add no engine startup text', () => {
  assert.ok(ownRuntimeNotices().includes(MAC_SAFETY_NOTICES.permissions));
  assert.equal(hash(JSON.stringify(ownRuntimeNotices())), baseline.ownRuntimeNotices);
  assert.ok(Buffer.byteLength(ownRuntimeNotices().join('\n')) < 2500);
});
test('native menu mechanism has a conditional pin and adds no startup text', () => {
  assert.equal(hash(JSON.stringify(ownRuntimeMenuNotices())), baseline.ownRuntimeMenuNotices);
  // GLS4 replaces the uncallable compound hint with the complete item-number fix.
  assert.ok(Buffer.byteLength(ownRuntimeMenuNotices().join('\n')) <= 140);
  assert.ok(ownRuntimeMenuNotices().every(notice => !ownRuntimeNotices().includes(notice)));
});
test('conditional Stop availability has its own pin and adds no startup text', () => {
  assert.equal(hash(JSON.stringify(ownRuntimeStopNotices())), baseline.ownRuntimeStopNotices);
  assert.ok(Buffer.byteLength(ownRuntimeStopNotices().join('\n')) <= 100);
  assert.ok(ownRuntimeStopNotices().every(notice => !ownRuntimeNotices().includes(notice)));
});
test('strict text refusal is pinned separately and adds no startup text', () => {
  assert.equal(hash(STRICT_TEXT_REFUSAL), baseline.strictTextNotice);
  assert.ok(Buffer.byteLength(STRICT_TEXT_REFUSAL) <= 200);
});
test('own-driver conditional read notices have a separate pin and no startup text', () => {
  assert.equal(hash(JSON.stringify(MAC_DRIVER_READ_NOTICES)), baseline.macDriverNotices);
  assert.ok(Object.values(MAC_DRIVER_READ_NOTICES).every(text => text.length < 80));
});
test('UC2D target recovery notices have a conditional pin and a 300 byte budget', () => {
  assert.equal(hash(JSON.stringify(MAC_DRIVER_TARGET_NOTICES)), baseline.macTargetRecoveryNotices);
  assert.ok(Buffer.byteLength(Object.values(MAC_DRIVER_TARGET_NOTICES).join('\n')) <= 300);
});
test('Windows REPL notices have a separate hash and add no Mac prompt text', { skip }, () => {
  assert.doesNotMatch(WINDOWS_SAFETY_UNAVAILABLE, /WDR\d+/);
  const windowsSkill = skillRules(undefined, {}, 'win32');
  const notices = [WINDOWS_REPL_DOCS, ...windowsReplTools().map(tool => tool.description), WINDOWS_SAFETY_UNAVAILABLE, WINDOWS_REPL_NODE_UNSUPPORTED,
    windowsSkill, ...Object.values(WINDOWS_FORBIDDEN_NOTICES), WINDOWS_STUCK_ESCAPE_NOTE, WINDOWS_TURN_END_FAILURE,
    ...budget ? taggedNoticeInventory(undefined, { windowsOnly: true }).map(e => e.text) : []];
  assert.equal(hash(JSON.stringify(notices)), baseline.windowsNotices);
  assert.ok(WINDOWS_TURN_END_FAILURE.length <= 200);
  assert.ok(WINDOWS_REPL_DOCS.length <= 3000);
  assert.ok(windowsSkill.split(/\s+/).length <= 500);
  assert.ok(WINDOWS_REPL_DOCS.length + windowsSkill.length <= 6500);
  for (const tool of windowsReplTools()) assert.ok(tool.description.length <= 2048);
  if (budget) {
    const measured = budget.budget({}).conditional.windowsRepl;
    assert.equal(measured.ordinary.characters, 0);
    const startup = taggedNoticeInventory(undefined, { windowsOnly: true });
    assert.equal(startup.length, 2);
    assert.ok(startup.every(row => row.path.startsWith('windows-launch.mjs:')));
    assert.ok(taggedNoticeInventory().every(row => !row.path.startsWith('windows-')));
    assert.equal(measured.startup.characters, startup.map(e => e.text).join('\n').length);
    assert.equal(measured.documentation.characters, [...WINDOWS_REPL_DOCS].length);
    assert.equal(measured.skill.characters, [...windowsSkill].length);
    assert.equal(measured.runtime.characters, WINDOWS_REPL_NODE_UNSUPPORTED.length);
    assert.equal(measured.admission.characters, [...Object.values(WINDOWS_FORBIDDEN_NOTICES), WINDOWS_STUCK_ESCAPE_NOTE].join('\n').length);
  }
});
const skillPath = new URL('../plugins/sleight/skills/drive-mac-apps/SKILL.md', import.meta.url);
// SF6 adds the concrete native refusal outcomes to the notice pin. The general
// source inventory cannot resolve the validator's dynamic signature interpolation.
const nativeRecovery = ['pressKey', 'typeText'].flatMap(method => [
  nativeArgumentError(method, [52, 'fixture']), nativeArgumentError(method, []),
]);
const noticeTexts = () => [...noticeInventory(), ...sharedNoticeInventory(), ...taggedNoticeInventory(), ...hookNoticeInventory()]
  .map(e => e.text).concat(FIRST_WINDOW_RULE, FIRST_WINDOW_LEAN_RULE, nativeRecovery, appPolicyNotices, preapprovedNotices, shellGuardReason, siteConsentNotice);

test('SF6 recovery notices preserve the refusal prefix and add only conditional guidance', () => {
  for (const [i, signature] of ['pressKey(key: string, options?: PressKeyOptions)', 'typeText(text: string)'].entries()) {
    const previous = 'sleight: invalid native arguments. Engine App.' + signature + '; nothing was sent';
    assert.equal(Buffer.byteLength(nativeRecovery[i * 2]) - Buffer.byteLength(previous), 45);
    assert.ok(nativeRecovery[i * 2].startsWith('sleight: invalid native arguments. Engine App.'));
    assert.match(nativeRecovery[i * 2], /; no target; click field first if focus wrong; nothing was sent$/);
    assert.equal(nativeRecovery[i * 2 + 1], previous);
    const unknown = Symbol();
    assert.equal(nativeArgumentError(['pressKey', 'typeText'][i], [32, unknown], unknown), nativeRecovery[i * 2]);
    assert.equal(nativeArgumentError(['pressKey', 'typeText'][i], [52, '']), previous);
    const mergedSF6 = signature + '; no target; click field first if focus wrong; nothing was sent';
    assert.equal(Buffer.byteLength(nativeRecovery[i * 2]) - Buffer.byteLength(mergedSF6), 46);
  }
});

// G11B shortens the eager cookie rule and counts conditional guard notices.
// p143 plus the cookie rule: default 1062 words, lean 517 words.
// HT1R counts the two conditional hook refusals in both variants (+151 characters).
// SM1R counts the new conditional managed-PATH refusal label (+54 characters).
// HO1 pins the shortened default and lean handoff descriptions.
// ST7 adds one conditional drop-hint template, 98 inventoried characters.
// INT6 keeps RB1 compression and restores SW1 safety wording.
// SKL1 and INT27W: native browser navigation grows by 77 default and 111 lean characters.
const navigationChars = { default: 77, lean: 111 };
const leanRatio = 32976 / 45084;
// AD3Q adds only this conditional refusal, inventoried once with its separator.
// Preserve the previous ceilings for all existing prompt text.
const quitNoticeChars = 225 + 1;
// TY1C inventories three recovery choices and the refusal's optional progress text.
// Actual notices before progress: paste 94, secure 91, unknown 185 characters.
const typeTextNoticeChars = 343 + 2;
// GL6 distinguishes a refused action from earlier delivered input in its cell.
const failedActionNotice = 'failed action sent no input';
const conditionalNoticeChars = quitNoticeChars + typeTextNoticeChars + failedActionNotice.length + 1;
test('GL6 failure delivery adds one conditional receipt phrase and no startup text', { skip }, () => {
  assert.equal(failedActionNotice.length, 27);
  assert.equal(taggedNoticeInventory().filter(row => row.text.includes(failedActionNotice)).length, 1);
  for (const env of [{}, { SLEIGHT_PROMPT: 'lean' }])
    assert.ok(!skillRules(skillPath, env).includes(failedActionNotice));
});
test('AD3Q3 pins the quit refusal at 225 characters, 75 above its original 150', () => {
  assert.equal(QUIT_KEY_REFUSAL.length, 225);
});
test('TY1C counts all recovery choices and progress without any typed text', { skip }, () => {
  const notices = taggedNoticeInventory().filter(row => row.text.includes('typeText garbles non-ASCII'));
  assert.equal(notices.length, 1);
  const unknownRecovery = 'Read the window again; use app.paste(<same text>) if focus is not a password field; otherwise ask the user to type it.';
  const recoveries = taggedNoticeInventory().filter(row => row.text === 'Use app.paste(<same text>).\nAsk the user to type it.\n' + unknownRecovery);
  assert.equal(recoveries.length, 1);
  assert.equal(notices[0].text.length + recoveries[0].text.length + 2, typeTextNoticeChars);
  assert.match(notices[0].text, /nothing typed/);
  assert.match(notices[0].text, /Other input in this cell may have run or still be running/);
  const prefix = 'sleight: typeText garbles non-ASCII on this engine; nothing typed. ';
  assert.equal((prefix + 'Use app.paste(<same text>).').length, 94);
  assert.equal((prefix + 'Ask the user to type it.').length, 91);
  assert.equal((prefix + unknownRecovery).length, 185);
});
const leanSkill = () => skillRules(skillPath, { SLEIGHT_PROMPT: 'lean' });

test('SF3 stays net-flat in every prompt ceiling with all safety and notice pins', { skip }, t => {
  const candidate = skillRules(skillPath, { SLEIGHT_SF3: '1' });
  assert.notEqual(candidate, skillRules(skillPath, {}));
  for (const env of [{}, { SLEIGHT_LEAN_CALLS: '1' }, { SLEIGHT_LEAN_FIRST: '1' },
    { SLEIGHT_SCREENSHOT_READS: '0' }, { SLEIGHT_PROMPT: 'lean' }, { SLEIGHT_BROWSER_CORE: '1' }]) {
    const off = skillRules(skillPath, env), on = skillRules(skillPath, { ...env, SLEIGHT_SF3: '1' });
    const section = /## Browsers\n[\s\S]*?(?=\n## |$)/;
    for (const rules of [on, on.replace(section, '').trim()]) {
      const previous = rules === on ? off : off.replace(section, '').trim();
      assert.ok(Buffer.byteLength(rules) <= Buffer.byteLength(previous), JSON.stringify(env));
      assert.ok(rules.trim().split(/\s+/).length <= previous.trim().split(/\s+/).length);
    }
    const native = on.replace(section, '').trim();
    assert.ok(Buffer.byteLength(native) + baseline.nativeRuleBudget.pf5BrowserSectionBytes - 1 <= baseline.nativeRuleBudget.ceiling);
    for (const passage of [...baseline.skillSafety, ...(env.SLEIGHT_PROMPT === 'lean' ? [] : baseline.nativeSafety)])
      assert.ok(on.includes(passage), passage);
    const normal = budget.budget(env), candidate = budget.budget({ ...env, SLEIGHT_SF3: '1' });
    for (const variant of ['default', 'lean']) {
      const metadata = readFileSync(skillPath, 'utf8').match(/^---\n[\s\S]*?\n---\n+/)[0];
      const delivered = metadata + skillRules(skillPath, { ...env, SLEIGHT_SF3: '1',
        SLEIGHT_PROMPT: variant === 'lean' ? 'lean' : undefined });
      const skillRow = candidate.rows.find(row => row.source === 'skill')[variant];
      assert.equal(skillRow.bytes, Buffer.byteLength(delivered));
      assert.equal(skillRow.characters, [...delivered].length);
      for (const [index, row] of candidate.rows.entries()) for (const measure of ['characters', 'bytes'])
        assert.ok(row[variant][measure] <= normal.rows[index][variant][measure]);
      assert.ok(candidate.total[variant].characters <= normal.total[variant].characters);
      for (const [key, value] of Object.entries(candidate.conditional.turboFirst[variant])) {
        if (typeof value !== 'object') continue;
        for (const measure of ['characters', 'bytes'])
          assert.ok(value[measure] <= normal.conditional.turboFirst[variant][key][measure]);
      }
      t.diagnostic(`${JSON.stringify(env)} ${variant}: ${JSON.stringify(candidate.total[variant])}`);
    }
  }
  assert.equal(hash(candidate), baseline.sf3Skill);
  assert.equal(hash(JSON.stringify(noticeTexts())), baseline.notices);
  assert.doesNotThrow(() => budget.budget({ SLEIGHT_SKILL: 'none' }), 'the inventory measures both skills even when delivery is disabled');
});

test('SF3 reaches the engine-path first rules and keeps browser rules deferred', t => {
  for (const extra of [{}, { SLEIGHT_LEAN_FIRST: '1' }, { SLEIGHT_LEAN_CALLS: '1' }]) {
    const h = placement(t, { ...extra, SLEIGHT_SF3: '1' });
    h.call(1, 'let app = await cua.getApp("Editor")');
    const first = h.reply(1, '## Computer Use\nNative reference.\nWindow: "Draft", App: Editor');
    assert.match(first, /Forms: unique observed/);
    assert.match(first, /Never retry stale numbers\./);
    assert.match(first, /Pick shown options\./);
    assert.match(first, /Stop at a required confirmation\./);
    assert.match(first, /Otherwise stop before the final click\./);
    assert.doesNotMatch(first, /sleight\.fillForm|tab\.getJsDialog/);
    h.call(2, 'await app.getAXState()');
    assert.doesNotMatch(h.reply(2, 'Native state'), /Forms: unique observed/);
  }
});

test('native rules fit the 1.4.2 ceiling even with PF5 browser wording', t => {
  const rules = skillRules(skillPath, {});
  const section = /## Browsers\n[\s\S]*?(?=\n## |$)/;
  const browser = readFileSync(new URL('../plugins/sleight/skills/drive-mac-apps/BROWSERS.turbo-v3.md', import.meta.url), 'utf8')
    .trimEnd().replace('{browser}', 'bbench').replace('{application}', ' (Google Chrome)');
  const full = rules.replace(section, browser + '\n');
  const native = rules.replace(section, '').trim();
  const { ceiling, nativeBytes, fullBytes, pf5BrowserSectionBytes } = baseline.nativeRuleBudget;
  assert.equal(Buffer.byteLength(native), nativeBytes);
  assert.equal(Buffer.byteLength(full), fullBytes);
  assert.ok(Buffer.byteLength(full) <= ceiling);
  // PF5's larger browser section includes its separator newline. Removing it and trimming
  // the remaining rules accounts for one fewer newline in the combined string.
  const pf5Projection = Buffer.byteLength(native) + pf5BrowserSectionBytes - 1;
  assert.ok(pf5Projection <= ceiling, `${pf5Projection} exceeds ${ceiling}`);
  for (const passage of baseline.nativeSafety) assert.ok(native.includes(passage), passage);
  for (const passage of baseline.skillSafety) assert.ok(native.includes(passage), passage);
  t.diagnostic(`Native ${nativeBytes}; combined ${fullBytes}; with PF5 browser section ${pf5Projection}; ceiling ${ceiling} UTF-8 bytes`);
});

// SB3 inventories conditional field-write notices and risk prefixes.
const wrongFieldNoticeBudget = 304;

test('SB3 field-write notices have a pinned conditional budget', { skip }, () => {
  const entries = taggedNoticeInventory().filter(entry => entry.path.startsWith('write-effect.mjs:'));
  assert.deepEqual(entries.map(e => e.text), [
    'Payment field received the text. ', 'Credential field received the text. ',
    'clear it before continuing. Requested write not done: <value> kept its value.',
    'check <value> and <value> before continuing.',
    'Other actions in this call ran; ',
    'sleight: <value>The text is now in <value>; <value> <value>sleight made no repair.',
  ]);
  assert.equal(entries.reduce((sum, entry) => sum + entry.text.length, 0), wrongFieldNoticeBudget);
});

test('lean field-write notices keep risk, recovery, unchanged target and no-repair evidence', { skip }, () => {
  const entries = taggedNoticeInventory('lean').filter(entry => entry.path.startsWith('write-effect.mjs:'));
  assert.deepEqual(entries.map(e => e.text), [
    'Text reached a payment field. ', 'Text reached a credential field. ',
    'clear it first. Write missed: <value> unchanged.',
    'check <value> and <value> first.', 'Other actions ran; ',
    'sleight: <value>Text reached <value>; <value> <value>No repair.',
  ]);
  assert.ok(entries.reduce((sum, entry) => sum + entry.text.length, 0) < wrongFieldNoticeBudget);
  const notice = 'sleight: Payment field received the text. The text is now in 9 (Card text field); ' +
    'clear it before continuing. Requested write not done: 7 (Address combo box) kept its value. ' +
    'Other actions in this call ran; sleight made no repair.';
  assert.equal(promptNotice(notice), notice);
  assert.equal(promptNotice(notice, 'lean'), 'sleight: Text reached a payment field. Text reached 9 (Card text field); ' +
    'clear it first. Write missed: 7 (Address combo box) unchanged. Other actions ran; No repair.');
});

test('hook guard refusals join the pinned notice inventory', { skip }, () => {
  const texts = taggedNoticeInventory().map(entry => entry.text);
  assert.ok(texts.includes(guardUnavailableReason));
  assert.ok(texts.includes(guardPathReason));
  assert.ok(texts.includes(unknownTabOutcome));
  assert.ok(texts.includes(pendingTabNote));
});

test('make-character description stays below 60 tokens even at one token per UTF-8 byte', t => {
  const source = readFileSync(new URL('../plugins/sleight/skills/make-character/SKILL.md', import.meta.url), 'utf8');
  const description = source.match(/^description: (.+)$/m)?.[1];
  assert.ok(description);
  assert.equal(hash(source), baseline.makeCharacterBody);
  const bytes = Buffer.byteLength(description);
  assert.ok(bytes < 60, `${bytes} bytes is the conservative token upper bound`);
  assert.equal(hash(description), baseline.makeCharacterDescription);
  const bodyBytes = Buffer.byteLength(source), words = source.trim().split(/\s+/).length;
  assert.match(source, /^disable-model-invocation: true$/m);
  // Codex 0.164.0 ignores disable-model-invocation. The reviewer observed that this manifest path
  // omits make-character from its model-visible skills; the path form is not documented upstream.
  const codex = JSON.parse(readFileSync(new URL('../plugins/sleight/.codex-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.equal(codex.skills, './skills/drive-mac-apps/');
  t.diagnostic(`make-character description: ${bytes} UTF-8 bytes, at most ${bytes} byte-level tokens; on-demand body: ${bodyBytes} UTF-8 bytes, ${words} words`);
});

test('outcome reporting guidance costs no default skill tokens', () => {
  for (const env of [{}, { SLEIGHT_PROMPT: 'lean' }, { SLEIGHT_LEAN_CALLS: '1' }])
    assert.doesNotMatch(skillRules(skillPath, env), /Report read completeness and unverified actions/);
});

test('opened-handle and engine-exit notices retain recovery details in lean wording', () => {
  const handle = 'handle src belongs to "file:///fixture/Source.txt"; window unconfirmed. Call select_window with {"app":"Editor","url":"file:///fixture/Source.txt"}.';
  const ended = 'Engine exited (0). Input outcome is unconfirmed; read the app again.';
  assert.equal(promptNotice(handle), handle);
  assert.equal(promptNotice(ended), ended);
  assert.equal(promptNotice(handle, 'lean'), 'handle src: "file:///fixture/Source.txt" unconfirmed. Call select_window with {"app":"Editor","url":"file:///fixture/Source.txt"}.');
  assert.equal(promptNotice(ended, 'lean'), 'Engine exited (0). Input unconfirmed; read again.');
});

test('the self-closed popup outcome has a reviewed prompt budget', () => {
  assert.equal(hash(closedTabOutcome), baseline.browserClosedOutcome);
  assert.ok(closedTabOutcome.length <= 80);
});

test('unknown or closed tab recovery text stays pinned within its reviewed size', () => {
  assert.equal(hash(unknownTabOutcome), baseline.browserUnknownTabOutcome);
  assert.ok(unknownTabOutcome.length <= 40);
});

test('handoff status lines have a measured prompt budget', () => {
  assert.equal(hash(JSON.stringify(handoffMessages)), baseline.browserHandoffOutcomes);
  assert.equal(Object.values(handoffMessages).reduce((size, text) => size + text.length, 0), 647);
});

test('the turbo skill reopens the page after an away handoff within its reviewed section byte budget', () => {
  const skill = readFileSync(new URL('../plugins/sleight/skills/drive-mac-apps/BROWSERS.turbo-v3.md', import.meta.url), 'utf8');
  assert.match(skill, /Reopen the page on their reply\./);
  assert.doesNotMatch(skill, /Read fresh on their next message/);
  assert.ok(Buffer.byteLength(skill) <= 2459);
  // PF3 + HO3: the section cap rises from 1,854 to 2,459 bytes while deferring 3,389 native
  // characters from the first request. Its catalog + first rules fall to 11,020 bytes.
  // Pin the section separately from HO1P's unchanged engine skill and catalogs.
  assert.equal(hash(skill), baseline.browserSkill);
});

test('wait and closed-submit review outcomes have a reviewed prompt budget', () => {
  const outcomes = [...Object.values(shortStepOutcomes), closedSubmitWarning, popupObservationHeader];
  assert.equal(hash(JSON.stringify(outcomes)), baseline.browserReviewOutcomes);
  assert.ok(outcomes.reduce((sum, text) => sum + text.length, 0) <= 241);
});

function placement(t, env = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const replies = [];
  clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    firstCallRules: skillRules(skillPath, env), leanFirst: env.SLEIGHT_LEAN_FIRST === '1' });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  return {
    call(id, code, name = 'js') { clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: { code } } }) + '\n'); },
    reply(id, text, browser = false, isError = false) {
      serverOut.write(JSON.stringify({ id, result: { isError, content: [{ type: 'text', text }],
        ...(browser ? { _meta: { 'codex/toolSurface': { kind: 'browserUse' } } } : {}) } }) + '\n');
      return replies.find(row => row.id === id).result.content.map(item => item.text ?? '').join('\n');
    },
  };
}

for (const env of [{}, { SLEIGHT_PROMPT: 'lean' }, { SLEIGHT_LEAN_CALLS: '1' }, { SLEIGHT_LEAN_FIRST: '1' }]) {
  const variant = JSON.stringify(env);
  test(`native acquisition keeps every pinned safety passage and defers browser rules: ${variant}`, t => {
    const h = placement(t, env);
    h.call(1, 'let app = await cua.getApp("Editor")');
    const first = h.reply(1, '## Computer Use\nNative reference.\nWindow: "Draft", App: Editor');
    for (const passage of baseline.skillSafety) assert.ok(first.includes(passage), passage);
    assert.match(first, /`app\.typeText\(text\)`.*`app\.pressKey\(key\)`.*no (?:element|index)/);
    assert.match(first, /Top-level `await`, no `return`/);
    assert.match(first, /Write text with `nodeRepl\.write\(\.\.\.\)`/);
    assert.doesNotMatch(first, /sleight\.fillForm|sleight\.dragTo|downloadMedia|tab\.getJsDialog/);
    // Engine-path browser sessions (Firefox, Safari) never see the Browsers section, so the form batching rule is outside it.
    if (env.SLEIGHT_PROMPT === 'lean') {
      assert.match(first, /`setValue` independent visible fields in one call\. Autocomplete last\./);
      assert.match(first, /Re-read after autocomplete, field-adding selection/);
    } else {
      assert.match(first, /`setValue` independent visible fields in one call\. Autocomplete last\./);
      assert.match(first, /Re-read after autocomplete, field-adding selection/);
    }
    assert.match(first, /async validation/);
    assert.match(first, /Stop at a required confirmation\./);
    // A native-first session can act in a browser before its first browser result: the submit rule and
    // tab-handle routing ride in the first rules, not with the deferred browser how-to.
    assert.match(first, /[Ss]top before the final click/);
    assert.match(first, /tab handle, never `getApp`/);
    h.call(2, 'nodeRepl.write(2 + 2)');
    assert.doesNotMatch(h.reply(2, '4'), /sleight\.fillForm/);
    h.call(3, 'let tab = await cua.getTab("1")');
    const browser = h.reply(3, 'Browser result', true);
    assert.match(browser, /sleight\.fillForm/);
    assert.match(browser, /stop if the user declines a browser approval/);
    assert.match(browser, /downloadMedia/);
    assert.match(browser, /tab\.getJsDialog/);
    assert.doesNotMatch(browser, /Never create or edit/);
    h.call(4, 'await tab.getAXState()');
    assert.doesNotMatch(h.reply(4, 'Browser state', true), /sleight\.fillForm/);
  });

  for (const reset of [false, true]) test(`deferred rules survive ${reset ? 'js_reset' : 'engine restart'} and reach a failed browser result: ${variant}`, t => {
    const h = placement(t, env);
    h.call(1, 'let app = await cua.getApp("Editor")');
    h.reply(1, '## Computer Use\nNative reference.');
    h.call(2, reset ? '' : 'await cua.listApps()', reset ? 'js_reset' : 'js');
    assert.doesNotMatch(h.reply(2, reset ? 'reset' : '## Computer Use\nNative reference.'), /sleight\.fillForm/);
    h.call(3, 'let b = await cua.getBrowser({})');
    assert.match(h.reply(3, 'Browser approval declined', false, true), /sleight\.fillForm/);
    h.call(4, 'await cua.listBrowsers()');
    assert.doesNotMatch(h.reply(4, '[]', true), /sleight\.fillForm/);
  });

  for (const docs of ['## Computer Use\nNative reference.', '# Other Browser APIs\nBrowser reference.']) {
    test(`browser-first receives common and browser safety with ${docs.split('\n')[0]}: ${variant}`, t => {
      const h = placement(t, env);
      h.call(1, 'let b = await cua.getBrowser({})');
      const first = h.reply(1, docs, true);
      for (const passage of baseline.skillSafety) assert.ok(first.includes(passage), passage);
      assert.match(first, /sleight\.fillForm/);
      h.call(2, 'await cua.listTabs()');
      assert.doesNotMatch(h.reply(2, '[]', true), /sleight\.fillForm|Never create or edit/);
    });
  }
}

test('lean calls teach persistent handles and action endings only under the experiment flag', () => {
  for (const prompt of [undefined, 'lean']) {
    const normal = skillRules(skillPath, { SLEIGHT_PROMPT: prompt });
    const selected = skillRules(skillPath, { SLEIGHT_PROMPT: prompt, SLEIGHT_LEAN_CALLS: '1' });
    if (prompt !== 'lean') {
      assert.match(selected, /Keep the app handle across calls/);
      assert.match(selected, /End on the action/);
    } else assert.equal(selected, normal, 'the lean skill has no native call guidance to replace');
    assert.ok(selected.split(/\s+/).length <= (prompt === 'lean' ? 519 : 1066));
    assert.equal(skillRules(skillPath, { SLEIGHT_PROMPT: prompt, SLEIGHT_LEAN_CALLS: '0' }), normal);
  }
});

test('lean calls change only the js description in both prompt variants', t => {
  function tools(leanCalls, prompt) {
    const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
    let result;
    clientOut.on('data', data => { result = JSON.parse(data.toString()); });
    const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, leanCalls, prompt });
    t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
    clientIn.write(JSON.stringify({ id: 1, method: 'tools/list' }) + '\n');
    serverOut.write(JSON.stringify({ id: 1, result: { tools: [{ name: 'js', description: firstRule }, { name: 'js_reset', description: 'Reset' }] } }) + '\n');
    return result.result.tools;
  }
  for (const prompt of [undefined, 'lean']) {
    const normal = tools(false, prompt), selected = tools(true, prompt);
    assert.match(selected[0].description, /keep the app handle across calls/);
    assert.match(selected[0].description, /End on the action/);
    assert.ok(selected[0].description.startsWith(normal[0].description));
    assert.deepEqual(selected[1], normal[1]);
  }
});

test('the default skill explains masked field reads without claiming a fill succeeded', () => {
  const skill = skillRules(skillPath, {});
  assert.match(skill, /engine masks protected field reads as `<redacted>`/);
  assert.match(skill, /does not mean input was replaced/);
  assert.match(skill, /Use validation or submission results\. Never try to unmask it/);
});

test('both skill variants explain browser routing and script input within their word budgets', () => {
  for (const [env, limit] of [[{}, 1066], [{ SLEIGHT_PROMPT: 'lean' }, 519]]) {
    const skill = skillRules(skillPath, env);
    assert.match(skill, /[Ww]eb pages.*tab handle, never `getApp`/);
    assert.match(skill, /[Tt]op-level `await`, no `return`/);
    assert.match(skill, /[Ww]rite text with `nodeRepl\.write\(\.\.\.\)`/);
    assert.doesNotMatch(skill, /last expression is the result/);
    assert.match(skill, /Tab-handle input.*first argument.*element index or `null`/);
    assert.match(skill, env.SLEIGHT_PROMPT === 'lean'
      ? /`setValue` independent visible fields in one call\. Autocomplete last\./
      : /`setValue` independent visible fields in one call\. Autocomplete last\./);
    assert.match(skill, /nodeRepl\.write\(await sleight\.fillForm\(tab,/);
    assert.match(skill, /by label or locator \(an index needs a stable ID in the tree\)/);
    if (!env.SLEIGHT_PROMPT) assert.match(skill, /nodeRepl\.write\(await sleight\.pickFromList\(tab, list, "Portland"\)\)/);
    else assert.doesNotMatch(skill, /sleight\.pickFromList/);
    assert.match(skill, /[Rr]ead once last/);
    assert.match(skill, /Submit in that call only when the user asked(?: for that submit)? and the engine's confirmation policy\s+doesn't require confirming it\./);
    assert.match(skill, /Otherwise stop before the final click\./);
    assert.doesNotMatch(skill, /submit in (?:that|the same) call when nothing is uncertain/i);
    assert.match(skill, /Use locators when validation(?: or |\/)autocomplete (?:can add or move|moves) fields, indices on static forms\./);
    assert.match(skill, /nodeRepl\.write\(await sleight\.dragTo\(tab, from, to\)\)/);
    assert.match(skill, /selectors, locators or page coordinates.*reads back/s);
    if (env.SLEIGHT_PROMPT === 'lean') assert.doesNotMatch(skill, /sleight\.reorder/);
    else assert.match(skill, /nodeRepl\.write\(await sleight\.reorder\(tab,list,order\)\)/);
    assert.match(skill, /Downloads: `locator\.downloadMedia\(\{\}\)`, never `tab\.click` \(stalls later downloads\)\./);
    assert.match(skill, /`tab\.click\(index\)`, not a locator, then answer it: `\(await tab\.getJsDialog\(\)\)\.accept\(\)`/);
    assert.ok(skill.trim().split(/\s+/).length <= limit, 'skill word budget');
  }
});

test('the default skill retains extension selection and lean retains precise safety instructions', () => {
  const normal = skillRules(skillPath, {}), lean = leanSkill();
  assert.match(normal, /With a connected ChatGPT extension/);
  assert.match(normal, /Several Chromium browsers report as Chrome/);
  assert.match(normal, /metadata\.extensionInstanceId.*await cua\.listBrowsers\(\)/s);
  assert.match(normal, /nodeRepl\.write\(await sleight\.pickFromList\(tab, list, "Portland"\)\)/);
  assert.doesNotMatch(lean, /sleight\.pickFromList/);
  assert.match(normal, /cua\.getBrowser\(\{ extensionInstanceId \}\).*in a call of its own/s);
  assert.match(lean, /tell the user first that it moves their pointer/i);
  assert.match(lean, /ask user to run `bin\/sleight-mcp --doctor` in plugin folder/);
  assert.match(lean, /the latest screenshot of that window/);
  assert.match(lean, /press Cmd\+Z in that window/);
  assert.match(lean, /Use only documented methods/);
  assert.match(lean, /leave tabs in the background/i);
  assert.match(lean, /stop if the user declines a browser approval/i);
  assert.match(lean, /brings the app forward for about two seconds/);
  assert.match(lean, /Submit in that call only when the user asked and the engine's confirmation policy doesn't require confirming it\. Otherwise stop before the final click\./);
  assert.match(lean, /Before `hover`, try `Help:`/);
});

test('nosavestop changes only the final stop clause and keeps the default prompt hashes', () => {
  assert.equal(hash(batchingDescription(firstRule, true)), baseline.batch);
  assert.equal(hash(batchingDescription(firstRule, 'merge')), baseline.merge);
  const clause = ', but end the call after a shortcut that opens or names a window (Cmd+N, Cmd+O, or Cmd+S on an untitled document): sleight stops the rest of a call when its window changes.';
  for (const prompt of [undefined, 'lean']) {
    const normal = batchingDescription(firstRule, true, prompt);
    assert.ok(normal.endsWith(clause));
    const expected = normal.slice(0, -clause.length) + '. sleight waits for the sheet a shortcut opens.';
    assert.equal(batchingDescription(firstRule, 'nosavestop', prompt), expected);
    assert.equal(batchingDescription('different engine wording', 'nosavestop', prompt), 'different engine wording');
  }
});

test('the launcher selects nosavestop without changing default, disabled or merge settings', async () => {
  const { firstCallBatchSetting } = await import('../plugins/sleight/lib/relay.mjs');
  for (const [value, expected] of [['nosavestop', 'nosavestop'], ['merge', 'merge'], ['0', false],
    [undefined, true], ['1', true], ['NOSAVESTOP', true]]) {
    assert.equal(firstCallBatchSetting?.(value), expected);
  }
});

test('only lean selects shorter text and RS off keeps the original skill hash', { skip }, () => {
  assert.ok(leanSkill().length < skillRules(skillPath, {}).length);
  // SF4's conditional pre-call rule joins the review hash without being charged as a default result notice.
  assert.equal(hash(JSON.stringify(noticeTexts())), baseline.notices);
  for (const env of [{}, { SLEIGHT_PROMPT: 'default' }, { SLEIGHT_PROMPT: 'LEAN' }]) {
    assert.equal(hash(skillRules(skillPath, { ...env, SLEIGHT_RS: '0' })), baseline.skill);
    assert.equal(hash(JSON.stringify(localToolDefinitions(env))), baseline.tools);
    assert.equal(hash(batchingDescription(firstRule, true, env.SLEIGHT_PROMPT)), baseline.batch);
    assert.equal(hash(batchingDescription(firstRule, 'merge', env.SLEIGHT_PROMPT)), baseline.merge);
  }
  const stripDescriptions = value => Array.isArray(value) ? value.map(stripDescriptions) :
    value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description').map(([key, item]) => [key, stripDescriptions(item)])) : value;
  assert.deepEqual(stripDescriptions(localToolDefinitions({ SLEIGHT_PROMPT: 'lean' })), stripDescriptions(localToolDefinitions({})));
});

test('lean retains the skill safety passages verbatim and removes named examples', { skip }, () => {
  const lean = leanSkill();
  assert.ok(lean.length < skillRules(skillPath, {}).length);
  for (const passage of baseline.skillSafety) assert.ok(lean.includes(passage), passage);
  const withoutSafety = baseline.skillSafety.reduce((text, passage) => text.replace(passage, ''), lean);
  const texts = [withoutSafety, batchingDescription(firstRule, true, 'lean'), batchingDescription(firstRule, 'merge', 'lean')];
  for (const variant of [true, 'merge']) assert.ok(batchingDescription(firstRule, variant, 'lean').includes('sleight acquires the app and checks its window before they run.'));
  assert.ok(batchingDescription(firstRule, true, 'lean').includes('but end the call after a shortcut that opens or names a window (Cmd+N, Cmd+O, or Cmd+S on an untitled document): sleight stops the rest of a call when its window changes.'));
  for (const tool of localToolDefinitions({ SLEIGHT_PROMPT: 'lean' })) {
    const safety = baseline.toolSafety[tool.name] ?? [];
    for (const passage of safety) assert.ok(tool.description.includes(passage), `${tool.name}: ${passage}`);
    texts.push(safety.reduce((text, passage) => text.replace(passage, ''), JSON.stringify(tool)));
  }
  assert.doesNotMatch(texts.join('\n'), /Calculator|TextEdit|Chess|Safari|Helium|iPhone|Simulator|Slack|Chrome|ChatGPT|Codex|Atlas|Terminal|iTerm2/);
  const [normalHover] = localToolDefinitions({}).filter(t => t.name === 'hover');
  const [leanHover] = localToolDefinitions({ SLEIGHT_PROMPT: 'lean' }).filter(t => t.name === 'hover');
  assert.equal(leanHover.inputSchema.properties.windowTitle.description, normalHover.inputSchema.properties.windowTitle.description);
  const sharedLean = sharedNoticeInventory('lean').map(e => e.text).join('\n');
  for (const entry of sharedNoticeInventory()) {
    for (const sentence of entry.text.split(/(?<=[.!?])\s+/)) {
      if (/^(?:Stop|Ask|Tell|Read|Before|Restarting|Never|Use|The user|Its settings|A yes)\b/.test(sentence)) assert.ok(sharedLean.includes(sentence), sentence);
    }
  }
});

test('lean changes relay additions without changing engine text or safety refusals', t => {
  function reply(prompt) {
    const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
    const output = [];
    clientOut.on('data', bytes => output.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
    const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, prompt, changeReview: false, firstCallBatch: true });
    t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'js', description: `ENGINE BEFORE ${firstRule} ENGINE AFTER` }] } }) + '\n');
    const description = output.at(-1).result.tools[0].description;
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [
      { type: 'text', text: 'ENGINE TEXT, including Calculator, stays unchanged.' },
      { type: 'image', data: 'same', mimeType: 'image/png' }, { type: 'image', data: 'same', mimeType: 'image/png' },
    ] } }) + '\n');
    const content = output.at(-1).result.content;
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'js', arguments: { code: 'app.click(1); app.typeText("x")' } } }) + '\n');
    return { description, content, refusal: output.at(-1).result };
  }
  const normal = reply(), lean = reply('lean');
  assert.ok(lean.description.length < normal.description.length);
  assert.match(lean.description, /^ENGINE BEFORE .* ENGINE AFTER$/);
  assert.deepEqual(lean.content.slice(0, 2), normal.content.slice(0, 2));
  assert.ok(lean.content.at(-1).text.length < normal.content.at(-1).text.length);
  assert.equal(lean.refusal.isError, true);
  assert.equal(normal.refusal.isError, true);
  assert.match(lean.refusal.content[0].text, /stopped this call before it ran:.*Add await at line \d+ and send it again\./);
});

// Lean was 30% under the default until both gained the same browser lines (29.7%, 2026-10-12).
test('shared notices count the browser lease advice and its lean variant', { skip }, () => {
  assert.ok(sharedNoticeInventory().some(entry => entry.text === 'For browser work, use cua.getBrowser(...) and its tab handle, or cua.listTabs() for inventory. cua.getApp(...) acquires a native app.'));
  assert.ok(sharedNoticeInventory('lean').some(entry => entry.text === 'Browser work: use cua.getBrowser(...) and its tab, or cua.listTabs() for inventory.'));
});

test('hook notices pin the Windows shell refusal reasons and templates', { skip }, () => {
  const notices = hookNoticeInventory();
  assert.ok(notices.some(entry => entry.text === 'uses an encoded PowerShell command flag'));
  assert.ok(notices.some(entry => entry.text === "names sleight's helper folder"));
  assert.ok(notices.some(entry => entry.text.includes('This command <value>. Only the user changes')));
});

test('the offline budget command measures all sources and stays about 30 percent under', { skip }, () => {
  const result = spawnSync(process.execPath, ['bench/prompt-budget.mjs', '--json'], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.rows.some(row => row.source === 'skill'));
  assert.ok(report.rows.some(row => row.source === 'js rewrite'));
  assert.ok(report.rows.some(row => row.source === 'relay notices'));
  assert.ok(report.rows.some(row => row.source === 'tool descriptions'));
  assert.ok(report.rows.some(row => row.source === 'shared notices'));
  assert.equal(taggedNoticeInventory().filter(row => row.text === QUIT_KEY_REFUSAL).length, 1);
  assert.ok(report.total.lean.characters - conditionalNoticeChars - navigationChars.lean <= 32976, JSON.stringify(report.total));
  assert.ok(report.total.lean.characters - conditionalNoticeChars - navigationChars.lean <= (report.total.default.characters - conditionalNoticeChars - navigationChars.default) * leanRatio, JSON.stringify(report.total));
});

test('the delivered default js prompt stays pinned within Claude Code’s description budget', () => {
  const engine = readFileSync(new URL('fixtures/engine-js-description.txt', import.meta.url), 'utf8').trimEnd();
  const description = compactJsDescription(engine, true, false);
  assert.equal(hash(description), baseline.js);
  assert.ok(description.length <= 2048);
});

test('SF4 keeps the initial description within the existing byte ceiling in default and lean modes', t => {
  const engine = readFileSync(new URL('fixtures/engine-js-description.txt', import.meta.url), 'utf8').trimEnd();
  for (const batch of [true, 'merge', 'nosavestop']) for (const lean of [false, true]) {
    const off = compactJsDescription(engine, batch, lean);
    const on = compactJsDescription(engine, batch, lean, false, { firstWindow: true });
    assert.ok(Buffer.byteLength(on) <= Buffer.byteLength(off));
    assert.ok(on.length <= 2048);
    assert.match(on, /`select_window` for the named window only, else stop/);
    t.diagnostic(`${batch}/${lean}: ${Buffer.byteLength(off)} -> ${Buffer.byteLength(on)} UTF-8 bytes`);
  }
});

// PB1 (2026-10-17): the compactor's notes, the document guard's stops and the stop notes were outside the count.
test('the budget counts compactor, guard and stop notes marked as notices', { skip }, () => {
  const texts = taggedNoticeInventory().map(entry => entry.text).join('\n');
  for (const text of [SCROLL_LOOP_NOTE, TEXTLESS_NOTE, 'UI changed (window)', 'sleight: <value> earlier reads of the same window in this call left out',
    'sleight: the click on <value> moved it from position', 'sleight: clicking also swapped', 'sleight: typed text landed in',
    'sleight: lines changed since the last full tree', 'sleight: this call ran <value>', 'Native access stopped: use the handle',
    'that object names no element', 'Input lease stopped this action: app changed.', 'Copy/Cut used the native clipboard.',
    'sleight sent one Escape to <value> to close a stuck menu']) assert.ok(texts.includes(text), text);
  const others = [...noticeInventory(), ...sharedNoticeInventory()].map(entry => entry.text);
  for (const entry of taggedNoticeInventory()) assert.ok(!others.includes(entry.text), `counted twice: ${entry.path}`);
});

// Log lines (ending in a newline, written to stderr) and internal [sleight:…] marks are not model-visible.
test('every sleight-prefixed literal in the relay, compactor, guard and stop notes is counted', { skip }, () => {
  const counted = [...noticeInventory(), ...sharedNoticeInventory(), ...taggedNoticeInventory()].map(entry => entry.text).join('\n');
  for (const file of ['relay.mjs', 'compact-reads.mjs', 'document-scope.mjs', 'menu-continuation.mjs']) {
    const source = readFileSync(new URL(`../plugins/sleight/lib/${file}`, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    (function visit(node) {
      const text = ts.isStringLiteralLike(node) ? node.text : ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map(span => '\0' + span.literal.text).join('') : undefined;
      if (text !== undefined && /^sleight(?::| stopped)/.test(text) && !text.endsWith('\n')) {
        const pieces = text.split('\0').filter(piece => piece.trim().length > 3);
        assert.ok(pieces.every(piece => counted.includes(piece)), `${file}:${ast.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${text}`);
      }
      ts.forEachChild(node, visit);
    })(ast);
  }
});

test('lean keeps the safety sentences of marked notices verbatim', { skip }, () => {
  const lean = taggedNoticeInventory('lean').map(entry => entry.text).join('\n');
  for (const entry of taggedNoticeInventory()) {
    for (const sentence of entry.text.split(/(?<=[.!?])\s+/)) {
      if (/^(?:Stop|Ask|Tell|Never|Before|The user|Only the user)\b/.test(sentence)) assert.ok(lean.includes(sentence), sentence);
    }
  }
});

test('the guard carries lean stop wording only under SLEIGHT_PROMPT=lean, and both forms compile', () => {
  const AsyncFunction = (async () => {}).constructor;
  const window = { app: 'Editor', title: 'Draft', url: undefined };
  const normal = guardedCode('await app.click(1);', window), lean = guardedCode('await app.click(1);', window, undefined, undefined, { prompt: 'lean' });
  assert.match(normal, /One call acts in one app: to switch apps/);
  assert.doesNotMatch(lean, /One call acts in one app: to switch apps/);
  assert.match(lean, /Send the rest in a new call/);
  assert.ok(lean.length < normal.length);
  for (const code of [normal, lean]) assert.doesNotThrow(() => new AsyncFunction(code));
});


test('AO prompt inventory counts browser_open and first-call guidance only under the flag, within the same ratio', { skip }, () => {
  const off = budget.budget({}), on = budget.budget({ SLEIGHT_BROWSER_CORE: '1' });
  for (const variant of ['default', 'lean']) {
    assert.ok(!off.details[variant].tools.some(e => e.source === 'browser_open'));
    assert.ok(on.details[variant].tools.some(e => e.source === 'browser_open'));
    assert.ok(on.total[variant].characters > off.total[variant].characters);
    const js = r => r.rows.find(row => row.source === 'js rewrite')[variant].characters;
    assert.equal(js(on) - js(off), 83);
  }
  assert.ok(on.total.lean.characters - typeTextNoticeChars <= (on.total.default.characters - typeTextNoticeChars) * leanRatio, JSON.stringify(on.total));
});

test('INT6 first browser request includes native handoff within the 1.4.2 ceiling', { skip }, () => {
  const report = budget.budget({});
  for (const variant of ['default', 'lean']) {
    const surface = report.conditional.turboFirst[variant];
    assert.ok(surface.withNativeHandoff.bytes <= 11736, JSON.stringify(surface));
  }
  assert.equal(report.conditional.turboFirst.default.withNativeHandoff.bytes, 10885);
  assert.equal(report.conditional.turboFirst.lean.withNativeHandoff.bytes, 11176);
  assert.ok(report.total.default.characters - conditionalNoticeChars - navigationChars.default <= 45912);
  assert.ok(report.total.lean.characters - conditionalNoticeChars - navigationChars.lean <= 32976);
});

import { withMT } from './fixtures/mt-env.mjs';
test('PF7 batch wording is default-off with its own catalog hash and unchanged schemas and notices', { skip }, async t => {
  const saved = process.env.SLEIGHT_FORM_BATCH;
  t.after(() => { if (saved === undefined) delete process.env.SLEIGHT_FORM_BATCH; else process.env.SLEIGHT_FORM_BATCH = saved; });
  await withMT(undefined, async () => {
    delete process.env.SLEIGHT_FORM_BATCH;
    const before = browserTools('bfixture');
    for (const value of ['0', 'true', 'yes']) {
      process.env.SLEIGHT_FORM_BATCH = value;
      assert.deepEqual(browserTools('bfixture'), before);
    }
    process.env.SLEIGHT_FORM_BATCH = '1';
    const after = browserTools('bfixture');
    assert.deepEqual(after.map(t => t.inputSchema), before.map(t => t.inputSchema));
    assert.deepEqual(after.filter(t => t.name !== 'browser_fill'), before.filter(t => t.name !== 'browser_fill'));
    assert.equal(hash(JSON.stringify(after)), baseline.browserToolsFormBatch);
    assert.equal(JSON.stringify(after).length - JSON.stringify(before).length, 32);
    assert.match(after.find(t => t.name === 'browser_fill').description, /same call as the last field/);
    assert.match(after.find(t => t.name === 'browser_fill').description, /select\/listbox\/combobox/);
    assert.match(after.find(t => t.name === 'browser_fill').description, /only when user asked/);
    assert.equal(hash(JSON.stringify(noticeTexts())), baseline.notices);
  });
  await withMT('0', async () => assert.equal(hash(JSON.stringify(browserTools('bfixture'))), baseline.browserToolsLegacy));
});
for (const mode of [undefined, '0']) test(`MT browser descriptions stay pinned inside existing budgets, switch=${mode}`, async () => withMT(mode, async () => {
  const tools = browserTools('bfixture');
  // TX1 changes both wording variants; MT=0 is not an unchanged pre-TX1 arm.
  assert.equal(hash(JSON.stringify(tools)), mode === '0' ? baseline.browserToolsLegacy : baseline.browserToolsMT);
  assert.equal(tools.find(tool => tool.name === 'browser_act').description.length, mode === '0' ? 1006 : 1103);
  // Both catalogs stay below the p170 sizes (6445 default, 6162 legacy).
  assert.equal(JSON.stringify(tools).length, mode === '0' ? 6101 : 6242);
  const descriptions = tools.map(tool => tool.description).join('\n');
  for (const prompt of [undefined, 'lean']) {
    const combined = skillRules(skillPath, { SLEIGHT_PROMPT: prompt }).length + descriptions.length;
    // HO1 pins the combined skill and description sizes in both MT variants.
    assert.equal(combined, mode === '0' ? (prompt === 'lean' ? 5886 : 8657) : (prompt === 'lean' ? 6027 : 8798));
  }
  assert.ok(JSON.stringify(tools).length < 8000);
  for (const tool of tools) assert.ok(tool.description.length <= 2048, tool.name);
}));

test('PF3 keeps every 1.5.0 input schema and pins both first and full turbo guidance', { skip }, () => {
  const schemas = browserTools('bbench').map(({ name, inputSchema }) => ({ name, inputSchema }));
  assert.equal(hash(JSON.stringify(schemas)), baseline.browserSchemas150);
  const browser = readFileSync(new URL('../plugins/sleight/skills/drive-mac-apps/BROWSERS.turbo-v3.md', import.meta.url), 'utf8')
    .trimEnd().replace('{browser}', 'bbench').replace('{application}', ' (Google Chrome)');
  const full = skillRules(skillPath, {}).replace(/## Browsers\n[\s\S]*?(?=\n## |$)/, browser + '\n');
  assert.equal(hash(full), baseline.browserFullRules);
  assert.equal(hash(turboFirstRules(full)), baseline.browserFirstRules);
  const measured = budget.budget({}).conditional.turboFirst.default;
  assert.equal(measured.catalog.characters, 6240);
  assert.equal(measured.rules.characters, 4332);
  assert.equal(measured.deferredCharacters, 2549);
  assert.equal(measured.combined.characters, 10573);
  assert.equal(Buffer.byteLength(JSON.stringify(browserTools('bbench')) + '\n' + turboFirstRules(full)), 10573);
  // This counts the browser catalog + skill, not host framing, native tools or Haiku tokens.
  assert.ok(measured.combined.characters <= 11736, 'below the same df27db01 surface');
  assert.ok(measured.combined.characters < 14166, 'below p160 a3706679');
});

// Remote context is absent on the ordinary path and inventoried as a conditional per-turn addition.
test('remote approval context has its own measured conditional budget', { skip }, () => {
  const report = budget.budget({});
  assert.equal(report.conditional.remoteApprovals.ordinary.characters, 0);
  assert.equal(report.conditional.remoteApprovals.upfront.text, 'sleight: Ask the user to reply: allow Mail, Word');
  assert.equal(report.conditional.remoteApprovals.upfront.characters, 48);
  assert.equal(report.conditional.remoteApprovals.upfront.lines, 1);
  assert.ok(report.conditional.remoteApprovals.refusal.characters < 100);
  assert.match(report.conditional.remoteApprovals.physical.text, /needs the user at the Mac/);
  assert.ok(report.conditional.remoteApprovals.physical.characters < 100);
});


test('GL1A 15: the Glide refusal stays outside every prompt inventory', { skip }, () => {
  const texts = [];
  for (const prompt of [undefined, 'lean']) {
    texts.push(skillRules(skillPath, { SLEIGHT_PROMPT: prompt }), JSON.stringify(localToolDefinitions({ SLEIGHT_PROMPT: prompt })),
      ...noticeInventory().map(row => row.text), ...sharedNoticeInventory().map(row => row.text),
      ...taggedNoticeInventory(prompt).map(row => row.text), ...hookNoticeInventory().map(row => row.text));
  }
  assert.doesNotMatch(texts.join('\n'), /glide-engine|GLIDE_ENGINE_LINE|That is sleight's Glide engine/);
});

test('Glide action ledger and delivery recovery have a conditional pin under 600 bytes', () => {
  const notices = ownRuntimeLedgerNotices();
  assert.equal(hash(JSON.stringify(notices)), baseline.ownRuntimeLedgerNotices);
  assert.ok(Buffer.byteLength(notices.join('\n')) < 600);
  assert.ok(notices.every(notice => !ownRuntimeNotices().includes(notice)));
});

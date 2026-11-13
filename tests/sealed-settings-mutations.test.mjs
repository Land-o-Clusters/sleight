import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const jsURL = new URL('../plugins/sleight/lib/sealed-settings.mjs', import.meta.url);
const swiftURL = new URL('../plugins/sleight/lib/mac-driver/native/SealedSettings.swift', import.meta.url);
const js = fs.readFileSync(jsURL, 'utf8'), swift = fs.readFileSync(swiftURL, 'utf8');
const jsTests = new URL('./sealed-settings.test.mjs', import.meta.url).href;
const nativeTests = new URL('./sealed-settings-native.test.mjs', import.meta.url).href;
// Each edit changes the implementation in a private copy. The witnesses stay unchanged.
const mutations = [
  ['M1', 'native', 'native MAC', 'settingsTimingSafeEqual(given, key: key, message: settingsMACMessage(record, file: file, counter: counter, bytes: bytes))', 'true'],
  ['M2', 'native', 'native MAC', 'guard counter == record.counters[file] else', 'guard counter <= (record.counters[file] ?? 0) else'],
  ['M3', 'native', 'native MAC', '["sleight-seal", "1", file, record.installId, String(counter), settingsHash(bytes)]', '["sleight-seal", "1", "", record.installId, String(counter), settingsHash(bytes)]'],
  ['M4', 'native', 'native MAC', '["sleight-seal", "1", file, record.installId, String(counter), settingsHash(bytes)]', '["sleight-seal", "1", file, "", String(counter), settingsHash(bytes)]'],
  ['M5', 'js', 'case 12', "return trustedSettingsContent(snapshot, relative(options.root ?? darwinPaths().settings, path),", "return legacyRead();\n  return trustedSettingsContent(snapshot, relative(options.root ?? darwinPaths().settings, path),"],
  ['M6', 'js', 'case 07', "if (!(proof === true || proof && typeof proof === 'object' && typeof proof.signed === 'boolean') || typeof helper !== 'function') fail('HELPER_UNTRUSTED');", "if (typeof helper !== 'function') fail('HELPER_UNTRUSTED');"],
  ['M7', 'native', 'every native intent', 'let settingsIntentForms = [SettingsIntentForm("verify", 0)', 'let settingsIntentForms = [SettingsIntentForm("write", 1), SettingsIntentForm("verify", 0)'],
  ['M8', 'js', 'verification and preview reads', 'const row = snapshot.get(file), note = settingsSealNote(row);', "const row = snapshot.get(file), note = settingsSealNote(row);\n    if (row.state !== 'trusted') { const fd = awaitNever; }"],
  ['M9', 'native', 'byte-identical shared fixture', 'Data(["sleight-seal", "1", file, record.installId, String(counter), settingsHash(bytes)].joined(separator: "\\0").utf8)', 'Data(["wrong-domain", "1", file, record.installId, String(counter), settingsHash(bytes)].joined(separator: "\\0").utf8)'],
  ['M10', 'js', 'case 01', 'return `sleight settings: ${row.file} ${row.state}; ${advice}`;', 'return undefined;'],
  ['M11', 'native', 'native recorded absence', 'if record?.present.contains(file) == true { return SettingsVerdict(file, "tampered") }', 'return SettingsVerdict(file, "absent")'],
  ['M12', 'native', 'native adoption requires', 'guard word == "adopt" && confirmed else { throw SettingsFault.person }', '// broken variant skips the adoption authorization'],
  ['M13', 'native', 'int22 readers', 'try settingsWriteDescriptor(fd, bytes: bytes)\n        let counter', 'try settingsWriteDescriptor(fd, bytes: Data("{}".utf8))\n        let counter'],
  ['M14', 'native', 'native posted Always', 'guard person else { throw SettingsFault.person }', '// broken variant accepts posted authorization'],
  ['M15', 'js', 'case 16', 'const result = helper([\'--settings\', \'verify\']);', "const result = helper(['--settings', 'verify']);\n  if (process.env.SLEIGHT_HAND === '0') return Object.freeze({ get: file => ({ file, state: 'tampered' }) });"],
  ['M16', 'native', 'production binary', '#if SLEIGHT_TEST_KEYSTORE\n// SLEIGHT_TEST_FILE_KEYSTORE', '#if true\n// SLEIGHT_TEST_FILE_KEYSTORE'],
];
// M8 must be a real destructive mutation, not an unrelated exception.
mutations.find(row => row[0] === 'M8')[4] = "const row = snapshot.get(file), note = settingsSealNote(row);\n    if (row.state !== 'trusted') unlinkSync(path);";

for (const [id, kind, pattern, before, after] of mutations) test(`${id}: unchanged witness rejects the broken variant`, { skip: kind === 'native' && process.platform !== 'darwin' }, t => {
  const bank = fs.realpathSync(trackTemp(fs.mkdtempSync(join(tmpdir(), 'sleight-seal-mutation-'))));
  t.after(() => fs.rmSync(bank, { recursive: true, force: true }));
  const original = kind === 'js' ? js : swift;
  assert.equal(original.split(before).length - 1, 1, `${id}: mutation target must be unique`);
  let edited = original.replace(before, after);
  const path = join(bank, kind === 'js' ? 'sealed-settings.mjs' : 'SealedSettings.swift');
  if (kind === 'js') {
    edited = edited.replace(/from '(\.[^']+)'/g, (_, specifier) => `from '${new URL(specifier, jsURL).href}'`);
    if (id === 'M8') edited = edited.replace("import { existsSync, lstatSync, readFileSync, realpathSync }", "import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync }");
  }
  fs.writeFileSync(path, edited);
  const entry = join(bank, 'witness.mjs');
  fs.writeFileSync(entry, kind === 'js'
    ? `import { sealedSettingsCases } from ${JSON.stringify(jsTests)}; import * as api from ${JSON.stringify(pathToFileURL(path).href)}; sealedSettingsCases(api);\n`
    : `import { nativeSettingsCases } from ${JSON.stringify(nativeTests)}; nativeSettingsCases({ source: ${JSON.stringify(path)}, productionCheck: ${id === 'M16'} });\n`);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync('/usr/bin/nice', ['-n', '20', process.execPath, '--test', '--test-reporter=tap', '--test-name-pattern', pattern, entry], {
    env, encoding: 'utf8', timeout: 900000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1, `${id} escaped its witness:\n${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stdout + result.stderr, /hookFailed|SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module|ReferenceError/,
    `${id} must fail its assertion, not its setup:\n${result.stdout}\n${result.stderr}`);
  const failures = Number(/# fail (\d+)/.exec(result.stdout)?.[1]);
  assert.ok(failures >= 1, result.stdout);
  t.diagnostic(`${id} killed: ${failures} failing witness tests, exit ${result.status}`);
});

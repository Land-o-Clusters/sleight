import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settingsChangeRefusal } from '../plugins/sleight/lib/launch.mjs';
import { confirmationLine, highStakesChange } from '../plugins/sleight/lib/person-confirm.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const launch = new URL('../plugins/sleight/lib/launch.mjs', import.meta.url);
const personGate = new URL('../plugins/sleight/lib/person-gate.mjs', import.meta.url);
const forms = [['replay', 'fixture.json'], ['record', 'fixture.jsonl'], ['record', '--watch', 'com.example.Fixture', 'out.json']];

for (const platform of ['darwin', 'win32']) for (const args of forms)
  for (const result of ['ok', 'cancelled', 'failed', 'timeout', 'unavailable', 'gate-refused'])
    test(`INT27H executable ${platform} ${args.slice(0, 2).join(' ')} ${result}`, t => {
      const root = trackTemp(mkdtempSync(join(realpathSync(tmpdir()), 'sleight-int27h-confirm-')));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const argv = args.map(arg => ['fixture.json', 'fixture.jsonl', 'out.json'].includes(arg) ? join(root, arg) : arg);
      if (result === 'ok') writeFileSync(join(root, 'fixture.json'), '{"steps":[]}');
      // The real launcher dispatch runs. Its process walk and confirmation are
      // injected, and every recording, relay and Windows dispatch is inert.
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { registerHooks } from 'node:module';
        const events = globalThis.__events = [];
        globalThis.__fixtureOutput = ${JSON.stringify(join(root, 'out.json'))};
        const result = ${JSON.stringify(result)};
        globalThis.__confirmationFixture = {
          presence: async () => { events.push('presence'); return true; },
          confirm: async found => { events.push('confirm:' + found.key); return result; },
          notice: text => events.push('notice:' + text)
        };
        const gate = 'export * from ' + ${JSON.stringify(JSON.stringify(personGate.href))} + ';' +
          'export async function settingsRefusalAsync() { globalThis.__events.push("gate"); return ' +
          (result === 'gate-refused' ? '"fixture terminal refusal"' : 'undefined') + '; }';
        const replay = 'export const record = () => { globalThis.__events.push("dispatch:record"); return {steps:[]}; };' +
          'export const replay = async () => { globalThis.__events.push("dispatch:replay"); return {ok:true,steps:0}; };' +
          'export const relayServer = () => { throw Error("unexpected relay"); }; export const replayOptions = () => ({});' +
          'export const replayBridge = () => { throw Error("unexpected relay bridge"); };';
        const demonstration = 'export const watchOptions = () => ({output:globalThis.__fixtureOutput});' +
          'export const recordWatch = async () => { globalThis.__events.push("dispatch:watch"); };';
        const windows = 'export async function windowsCommand(args) { globalThis.__events.push("dispatch:windows:"+args[0]); return 0; }';
        registerHooks({
          resolve(specifier, context, next) {
            if (context.parentURL === ${JSON.stringify(launch.href)}) {
              const source = {'./person-gate.mjs':gate, './replay.mjs':replay, './demonstration.mjs':demonstration, './windows-launch.mjs':windows}[specifier];
              if (source) return {url:'data:text/javascript;base64,'+Buffer.from(source).toString('base64'),shortCircuit:true};
            }
            return next(specifier, context);
          },
          load(url, context, next) {
            const loaded = next(url, context);
            if (url !== ${JSON.stringify(launch.href)}) return loaded;
            const source = String(loaded.source);
            if (!source.includes('...confirmation });')) throw Error('missing confirmation fixture anchor');
            return {...loaded, source:source.replace('...confirmation });', '...confirmation, ...globalThis.__confirmationFixture });')};
          }
        });
        Object.defineProperty(process, 'platform', {value:${JSON.stringify(platform)}});
        process.argv = [process.execPath, ${JSON.stringify(launch.pathname)}, ...${JSON.stringify(argv)}];
        await import(${JSON.stringify(launch.href)});
        process.stdout.write('\\nEVENTS:' + JSON.stringify(events) + '\\n');
      `], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
      assertChildStatus(child, result === 'ok' ? 0 : 3, child.stderr);
      const events = JSON.parse(/EVENTS:(.*)/.exec(child.stdout)?.[1] ?? 'null');
      assert.ok(events, child.stdout);
      assert.equal(events[0], 'gate');
      const confirms = events.filter(event => event.startsWith('confirm:'));
      const dispatches = events.filter(event => event.startsWith('dispatch:'));
      if (result === 'gate-refused') {
        assert.deepEqual(confirms, []); assert.deepEqual(dispatches, []);
        assert.deepEqual(events, ['gate']);
      } else {
        assert.deepEqual(confirms, ['confirm:' + args[0]]);
        assert.equal(events.filter(event => event.startsWith('notice:')).length, 1);
        const notice = events.find(event => event.startsWith('notice:'));
        assert.ok(notice.includes(args[0] === 'replay' ? 'runs a saved script' : 'records or converts a run'));
        assert.match(notice, platform === 'win32' ? /Windows Hello/ : /Touch ID/);
        if (result === 'ok') assert.equal(dispatches.length, 1);
        else {
          assert.deepEqual(dispatches, []); assert.match(child.stderr, /nothing ran/);
          assert.match(child.stderr, platform === 'win32' ? /Windows Hello/ : /Touch ID/);
        }
      }
    });

for (const family of ['replay', 'record']) test(`INT27H ${family} confirmation deadline refuses before dispatch`, async () => {
  const events = [];
  const refusal = await settingsChangeRefusal([family, 'fixture.json'], {
    gate: () => { events.push('gate'); },
    confirmation: { presence: async () => true, notice: () => {}, timeoutMs: 5, graceMs: 5,
      confirm: (found, { ready }) => { events.push(found.key); ready(); return new Promise(() => {}); } },
  });
  if (!refusal) events.push('dispatch');
  assert.equal(refusal, confirmationLine(family + ' fixture.json', 'timeout'));
  assert.deepEqual(events, ['gate', family]);
});
test('INT27H every replay and record form confirms without passing source text to the helper', () => {
  for (const family of ['replay', 'record']) for (const rest of [[], ['--help'], ['--status'], ['future-form'], ['untrusted\nsource']])
    assert.deepEqual(highStakesChange([family, ...rest]), { key: family });
});
for (const family of ['replay', 'record']) test(`INT27H ${family} gate exception refuses before confirmation`, async () => {
  const line = await settingsChangeRefusal([family, 'missing.json'], { gate() { throw Error('fixture walk failed'); },
    confirmation: { confirm() { assert.fail('confirmation after a failed gate'); } } });
  assert.match(line, /starts a separate recording or replay/);
  assert.match(line, /Reason: check failed\.$/);
});

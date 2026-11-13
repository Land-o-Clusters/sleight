import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { replWorkerSkip } from './fixtures/repl-requirement.mjs';

// Offline source mutations prove each approval regression is observed by the
// real relay fixture. No installed files, helper processes or app UI are used.
const variants = [
  ['risk ceiling', 'runtime-select.mjs',
    "preapproved.allows(card.app, 'low')", 'preapproved.allows(card.app, card.riskLevel)',
    'GL3 saved bundle grants admit Glide at every ceiling and write an audit line'],
  ['display-name fallback', 'runtime-select.mjs',
    "preapproved.allows(card.app, 'low')", "(preapproved.allows(card.app, 'low') || preapproved.allows(card.name, 'low'))",
    'GL3 name-only grants never admit Glide'],
  ['any bundle grant', 'runtime-select.mjs',
    "preapproved.allows(card.app, 'low')", 'preapproved.list().length > 0',
    'GL3 a different bundle grant never admits Glide'],
  ['forbidden policy bypass', 'mac-safety.mjs',
    "return { ...verdict, message: verdict.sentence, riskLevel: 'high' };",
    "return { ...verdict, allow: true, message: verdict.sentence, riskLevel: 'high' };",
    'GL3 a saved grant never overrides a forbidden category'],
  ['warning bypass', 'runtime-select.mjs',
    "!card.warning && preapproved.allows(card.app, 'low')", "preapproved.allows(card.app, 'low')",
    'GL3 a warning verdict still asks with a saved grant'],
  ['shared ceiling removed', 'preapproved.mjs',
    'RISK.get(riskLevel) <= this.#apps.get(app)', 'true',
    'GL3 the ChatGPT engine ceiling API still rejects high against a low grant'],
  ['Always allow saves low', 'runtime-select.mjs',
    'await storage.add(card.app, card.riskLevel);', "await storage.add(card.app, 'low');",
    'GL3 Always allow from a Glide card still writes high'],
  ['audit omitted', 'runtime-select.mjs',
    "audit({ app: card.app, riskLevel: card.riskLevel, tool: 'own', source: '~/Library/Application Support/sleight/preapproved.json' });",
    '/* broken variant omits the grant audit */',
    'GL3 saved bundle grants admit Glide at every ceiling and write an audit line'],
];

for (const [name, file, from, to, target] of variants) {
  test(`GL3 detects broken variant: ${name}`, { skip: name !== 'shared ceiling removed' && replWorkerSkip }, t => {
    const hook = `import { registerHooks } from 'node:module';
      registerHooks({ load(url, context, next) {
        const result = next(url, context);
        if (url.endsWith(${JSON.stringify('/plugins/sleight/lib/' + file)})) {
          const source = String(result.source), from = ${JSON.stringify(from)};
          if (!source.includes(from)) throw Error('GL3_MUTATION_NOT_APPLIED');
          return { ...result, source: source.replace(from, ${JSON.stringify(to)}) };
        }
        return result;
      } });`;
    const child = spawnSync(process.execPath, [
      '--import', 'data:text/javascript;base64,' + Buffer.from(hook).toString('base64'),
      '--test', '--test-reporter=tap', '--test-name-pattern=^' + target + '$', 'tests/mac-safety-relay.test.mjs',
    ], { timeout: 20000, killSignal: 'SIGKILL', encoding: 'utf8',
      env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
    const output = child.stdout + child.stderr;
    assert.equal(child.status, 1, output);
    assert.doesNotMatch(output, /GL3_MUTATION_NOT_APPLIED|SyntaxError|ERR_MODULE_NOT_FOUND/);
    assert.ok(output.includes('not ok 1 - ' + target), output);
    assert.match(output, /# fail 1\b/);
    t.diagnostic(`broken ${name}: node --test --test-name-pattern="^${target}$" tests/mac-safety-relay.test.mjs`);
    t.diagnostic(`exit ${child.status}; ${output.split('\n').filter(line => /^(not ok|# (tests|pass|fail|skipped))/.test(line)).join('; ')}`);
  });
}

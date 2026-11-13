import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { preapprovedWriteTarget, preapprovedWriteDenied as denied, loggingSwitchWriteDenied, MAX_PROTECTED_COMMAND, PROTECTED } from '../plugins/sleight/hooks/preapproved-write-guard.mjs';
import { protectedTargets } from './fixtures/gd3-write-cases.mjs';
import { reviewBank } from './fixtures/gd5-review-bank.mjs';

// A Mac home root, built so the test path guard's literal scan doesn't flag it.
const MAC_U = ['', 'Users', 'u'].join('/');
const options = { stat: async path => ({ realPath: path }), home: MAC_U, configDir: `${MAC_U}/.claude`, platform: 'darwin' };
const pad = command => [
  '#'.repeat(70000) + '\n' + command,
  command + '\n' + '#'.repeat(70000),
  '#'.repeat(65535 - command.length) + '\n' + command + '\n#',
];
test('GD5 retains all 80 reviewer commands as data', () => assert.equal(reviewBank.length, 80));
for (const [index, command] of reviewBank.entries()) test(`GD5 oversized review bank ${index + 1}`, async () => {
  for (const padded of pad(command)) {
    let probes = 0;
    assert.equal(await preapprovedWriteTarget({ tool: 'Bash', command: padded }, { ...options, stat: async () => { probes++; } }), PROTECTED.oversized, command);
    assert.equal(probes, 0);
  }
});

const ancestors = ['~', '~/Library', '~/Library/Application Support', '~/Library/Application Support/sleight',
  '~/.claude', '~/.claude/plugins', '~/.claude/plugins/cache', '~/.local/bin'];
const destructive = [p => `rm -rf ${p}`, p => `mv ${p} /tmp/aside`, p => `chmod -R u-w ${p}`, p => `chown -R root ${p}`,
  p => `find ${p} -delete`, p => `truncate -s 0 ${p}`, p => `dd of=${p}`, p => `rsync --delete -a x/ ${p}`];
for (const ancestor of ancestors) test(`GD5 oversized ancestor ${ancestor}`, async () => {
  for (const root of ['~', '$HOME', MAC_U]) for (const writer of destructive) {
    const command = writer(JSON.stringify(ancestor.replace('~', root)));
    for (const padded of pad(command)) assert.equal(await denied({ tool: 'Bash', command: padded }, options), true, command);
  }
});
for (const decoder of ['base64 -d', 'xxd -r', 'openssl enc -d']) test(`GD5 oversized decoder ${decoder}`, async () => {
  for (const runner of ['sh', 'bash', 'zsh', 'python', 'node', 'perl', 'ruby', 'osascript']) {
    for (const command of pad(`echo ZGF0YQ== | ${decoder} | ${runner}`)) assert.equal(await denied({ tool: 'Bash', command }, options), true);
  }
});
for (const body of ['echo `date`', 'echo x > ~/Library/Application\\ Support/`echo s`l`echo eight`/`echo h`a`echo nd`.json',
  'echo %name with spaces%']) {
  test(`GD5 oversized expansions ${body}`, async () => {
    for (const command of pad(body)) assert.equal(await denied({ tool: 'Bash', command }, options), true);
  });
}

const writers = [
  p => `rsync -avt /tmp/x ${p}`, p => `rsync -rlpt /tmp/x ${p}`, p => `rsync -rlptgoD /tmp/x ${p}`, p => `rsync -t /tmp/x ${p}`,
  p => `sed $'-i' '' 's/a/b/' ${p}`, p => `sed $'-I' '' 's/a/b/' ${p}`,
  p => `curl -fsSLo ${p} https://example.invalid/x`, p => `curl -sSLo${p} https://example.invalid/x`,
  p => `gsed -i 's/a/b/' ${p}`, p => `arch -arm64 tee ${p}`,
  p => `curl -D ${p} https://example.invalid/x`, p => `curl -c ${p} https://example.invalid/x`,
  p => `gcp -t ${p} hand.json`, p => `gmv src ${p}`, p => `ginstall -Dt ${p} hand.json`,
  p => `gtee ${p}`, p => `gdd of=${p}`, p => `gtruncate -s 0 ${p}`, p => `gln src ${p}`,
];
for (const path of protectedTargets) test(`GD5 writer regressions ${path}`, async () => {
  for (const writer of writers) {
    const command = writer(JSON.stringify(path));
    assert.equal(await denied({ tool: 'Bash', command }, options), true, command);
  }
  const escaped = path.replaceAll(' ', '\\ ');
  for (const inner of [`touch ${escaped}`, `echo x > ${escaped}`, `tee -a ${escaped}`, `cp /tmp/x ${escaped}`]) {
    for (const shell of ['sh', 'bash', 'zsh']) {
      const command = `${shell} -c "${inner}"`;
      assert.equal(await denied({ tool: 'Bash', command }, options), true, command);
    }
  }
});
for (const command of [
  'cd /tmp; (cd "~/Library/Application Support/sleight"); echo x > hand.json',
  'pushd /tmp; (pushd "~/Library/Application Support/sleight"; popd); echo x > hand.json',
  'cd /tmp; cd -; cd /tmp; echo x > hand.json',
  'rsync -avt /tmp/x /tmp/ordinary-output', "sed $'-I' '' 's/a/b/' /tmp/ordinary-output",
  'arch -arm64 tee /tmp/ordinary-output',
]) test(`GD5 preserves ordinary scoped writes ${command}`, async () => {
  assert.equal(await denied({ tool: 'Bash', command }, options), false);
});
for (const directory of ['~/Library/Application Support/sleight', '~/Library/Caches/sleight', '~/.claude/plugins/cache/local/sleight/1']) {
  test(`GD5 destination directory ${directory}`, async () => {
    const d = JSON.stringify(directory);
    for (const command of [`curl -O --output-dir ${d} https://example.invalid/hand.json`,
      `curl -sS -O --output-dir ${d} https://example.invalid/hand.json`, `bsdtar -xf a -C ${d}`, `tar -xf a --cd ${d}`]) {
      assert.equal(await denied({ tool: 'Bash', command }, options), true, command);
    }
  });
}
const d = '"~/Library/Application Support/sleight"';
for (const prefix of [`cd ${d}; (cd /tmp)`, `cd ${d}; cd /tmp; cd -`, `pushd ${d}; pushd -n /tmp`,
  `pushd ${d}; pushd /tmp; pushd`, `pushd /tmp; pushd ${d}; pushd +1`, 'cd', 'builtin cd',
  `cd ${d}; cd -; (cd /tmp)`,
  `cd ${d}; cd ${'x/'.repeat(600)}`]) {
  test(`GD5 uncertain working directory ${prefix.slice(0, 90)}`, async () => {
    const file = ['cd', 'builtin cd'].includes(prefix) ? 'Library/Application\\ Support/sleight/hand.json' : 'hand.json';
    assert.equal(await denied({ tool: 'Bash', command: `${prefix}; echo x > ${file}` }, options), true);
  });
}

const timingShapes = [
  ['growing cd and many writers', n => 'cd x;'.repeat(Math.floor(n / 10)) + 'touch f;'.repeat(Math.floor(n / 16))],
  ['one long cd and many writers', n => 'cd /tmp/' + 'x'.repeat(Math.floor(n / 2) - 20) + ';' + 'touch f;'.repeat(Math.floor(n / 16))],
  ['nested python open', n => "python3 -c '" + 'open('.repeat(Math.floor((n - 14) / 5)) + "'"],
  ['nested node open', n => "node -e '" + 'open('.repeat(Math.floor((n - 11) / 5)) + "'"],
];
const minimum = values => Math.min(...values);
const sampleCount = 21;
// First Mac calibration at 65,536 chars: guard 35.752, switches 12.121 CPU ms.
// Ceilings give 4.47x and 4.95x margin for slower CPUs, including a 2-CPU VM.
// Linux qualification remains separate. A uniformly tenfold slowdown fails.
const cpuLimit = { guard: 160, switches: 60 };
const assertLinear = (baseline, measured, scale, label) => {
  // Four times the text gets at most eight times the CPU work. Quadratic growth
  // would be sixteen times. CPU time excludes time descheduled on a shared VM.
  assert.ok(measured <= baseline * scale * 2, `${label}: ${measured} CPU ms vs ${baseline} baseline at ${scale}x text`);
};
const assertBounded = (measured, scanner, label) => {
  assert.ok(measured <= cpuLimit[scanner], `${label}: ${measured} CPU ms exceeds ${cpuLimit[scanner]} CPU ms`);
};
test('GD5 minimum resists the recorded bimodal samples and retains both CPU bounds', () => {
  // lin160b-review: 1.00 and 3.9 ms modes flipped the median at 32,768.
  assertLinear(minimum([1.02, 3.92, 1.00, 1.06, 3.88, 1.00, 1.01]),
    minimum([3.869, 3.652, 4.371, 2.0, 3.9, 4.0, 4.1]), 2, 'recorded modes');
  assertLinear(10, 40, 4, 'linear');
  assert.throws(() => assertLinear(10, 160, 4, 'quadratic'), /quadratic/);
  assertLinear(100, 400, 4, 'uniform slowdown');
  assert.throws(() => assertBounded(400, 'guard', 'uniform slowdown'), /exceeds/);
});
async function sampleScanners(make, { guard = preapprovedWriteTarget, switches = loggingSwitchWriteDenied, rounds = sampleCount } = {}) {
  const measure = async size => {
    let probes = 0;
    const body = make(size), command = body + ' '.repeat(size - body.length);
    const switchBody = make(size - 32), switchCommand = switchBody + '; echo SLEIGHT_OUTCOMES=1';
    assert.ok(switchCommand.length <= MAX_PROTECTED_COMMAND);
    const start = performance.now(), cpuStart = process.cpuUsage();
    const target = await guard({ tool: 'Bash', command }, { ...options,
      stat: async path => { probes++; return { realPath: path }; } });
    const cpu = process.cpuUsage(cpuStart), elapsed = performance.now() - start;
    const switchStart = process.cpuUsage();
    switches({ tool: 'Bash', command: switchCommand });
    const switchCpu = process.cpuUsage(switchStart);
    assert.notEqual(target, PROTECTED.oversized);
    assert.ok(probes <= 4096, `${probes} filesystem probes`);
    return { guard: (cpu.user + cpu.system) / 1000, switches: (switchCpu.user + switchCpu.system) / 1000, elapsed, probes };
  };
  // CPU samples include background GC/JIT work. The minimum of 21 interleaved
  // samples estimates scanner work without depending on the mixture of modes.
  await measure(65536);
  const samples = new Map([16384, 32768, 65536].map(size => [size, []]));
  for (let round = 0; round < rounds; round++) {
    for (const [size, values] of samples) values.push(await measure(size));
  }
  return samples;
}
for (const [name, make] of timingShapes) test(`GD5 bounded scan ${name}`, { timeout: 30_000 }, async t => {
  const samples = await sampleScanners(make), baseline = samples.get(16384);
  for (const [size, values] of samples) {
    for (const scanner of ['guard', 'switches']) {
      const base = minimum(baseline.map(v => v[scanner])), measured = minimum(values.map(v => v[scanner]));
      assertLinear(base, measured, size / 16384, `${size} ${scanner}`);
      if (size === 65536) assertBounded(measured, scanner, `${size} ${scanner}`);
      t.diagnostic(`${name}: ${size} ${scanner} minimum=${measured.toFixed(3)} CPU ms ratio=${(measured / base).toFixed(4)} scale=${size / 16384} samples=${sampleCount}`);
    }
    t.diagnostic(`${size} characters: minimum wall ${minimum(values.map(v => v.elapsed)).toFixed(3)} ms, ${Math.max(...values.map(v => v.probes))} probes`);
  }
});

test('GD5 measured real scanners reject quadratic and synthetic excess-work variants', { timeout: 30_000 }, async t => {
  for (const [name, work] of [['quadratic', size => 8 * (size / 16384) ** 2], ['excess', () => 180]]) {
    // The real scanners still execute. Inject actual extra CPU work through the
    // same measurement path, so this tests more than the ratio arithmetic.
    const burn = size => {
      const began = process.cpuUsage();
      while (true) {
        const cpu = process.cpuUsage(began);
        if ((cpu.user + cpu.system) / 1000 >= work(size)) break;
      }
    };
    const samples = await sampleScanners(timingShapes[3][1], {
      rounds: 3,
      guard: async (request, opts) => { const value = await preapprovedWriteTarget(request, opts); burn(request.command.length); return value; },
      switches: request => { const value = loggingSwitchWriteDenied(request); burn(request.command.length); return value; },
    });
    for (const scanner of ['guard', 'switches']) {
      const base = minimum(samples.get(16384).map(v => v[scanner]));
      const measured = minimum(samples.get(65536).map(v => v[scanner]));
      if (name === 'quadratic') assert.throws(() => assertLinear(base, measured, 4, name), /quadratic/);
      else assert.throws(() => assertBounded(measured, scanner, name), /excess/);
      t.diagnostic(`${name} ${scanner}: ${base.toFixed(3)} to ${measured.toFixed(3)} CPU ms`);
    }
  }
});

test('GD5 absolute CPU bound rejects uniformly tenfold real scanner work', { timeout: 30_000 }, async t => {
  const samples = await sampleScanners(timingShapes[0][1], {
    rounds: 3,
    guard: async (request, opts) => {
      let value;
      for (let i = 0; i < 10; i++) value = await preapprovedWriteTarget(request, opts);
      return value;
    },
    switches: request => {
      let value;
      for (let i = 0; i < 10; i++) value = loggingSwitchWriteDenied(request);
      return value;
    },
  });
  for (const scanner of ['guard', 'switches']) {
    const base = minimum(samples.get(16384).map(v => v[scanner]));
    const measured = minimum(samples.get(65536).map(v => v[scanner]));
    assertLinear(base, measured, 4, `tenfold ${scanner}`);
    assert.throws(() => assertBounded(measured, scanner, `tenfold ${scanner}`), /tenfold/);
    t.diagnostic(`tenfold ${scanner}: ${base.toFixed(3)} to ${measured.toFixed(3)} CPU ms`);
  }
});

test('GD5 a distinct metadata probe budget fails closed', async t => {
  let probes = 0;
  const command = 'touch ' + Array.from({ length: 3000 }, (_, i) => `/tmp/path${i}/file`).join(' ');
  assert.ok(command.length < MAX_PROTECTED_COMMAND);
  assert.equal(await preapprovedWriteTarget({ tool: 'Bash', command }, { ...options,
    stat: async path => { probes++; return { realPath: path }; } }), PROTECTED.unresolved);
  assert.ok(probes <= 2048, `${probes} probes`);
  t.diagnostic(`${probes} distinct probes, unresolved refusal`);
});
test('GD5 repeated ordinary destinations reuse metadata without refusing', async t => {
  let probes = 0;
  const command = 'touch ' + '/tmp/a/b/c/file '.repeat(3000);
  assert.ok(command.length < MAX_PROTECTED_COMMAND);
  assert.equal(await denied({ tool: 'Bash', command }, { ...options,
    stat: async path => { probes++; return { realPath: path }; } }), false);
  assert.ok(probes <= 6, `${probes} probes`);
  t.diagnostic(`${probes} probes for 3000 ordinary destinations`);
});
test('GD5 linear open scan retains an opening parenthesis in a quoted path', async () => {
  const path = `${MAC_U}/x(/../Library/Application Support/sleight/hand.json`;
  for (const mode of ["'w'", "mode='a'"]) {
    assert.equal(await denied({ tool: 'Bash', command: `python3 -c 'open("${path}", ${mode.replaceAll("'", '"')})'` }, options), true);
  }
  assert.equal(await denied({ tool: 'Bash', command: `python3 -c 'open("${path}", "r")'` }, options), false);
});

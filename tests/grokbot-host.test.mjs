import { macCommandSkip } from './requirements.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { grokbotDoctorLines, grokbotStatus, grokbotSessionStatus, readNativeAccessibility } from '../plugins/sleight/lib/grokbot-host.mjs';
import { doctor } from '../plugins/sleight/lib/launch.mjs';

const systemPlist = '/Applications/Grok Bot.app/Contents/Info.plist';
const userPlist = '/home/Applications/Grok Bot.app/Contents/Info.plist';
const gate = '/home/.grokbot/local-computer-use-gate.json';
const settings = '/home/.grokbot/settings.json';
const daemon = '/home/.grokbot/local-exec-daemon.json';
const plist = version => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`;
const installed = {
  [systemPlist]: plist('0.71.2'),
  [gate]: '{"isOn":false}',
  [settings]: '{"localToolPermission":"always","mcpBoxServers":{"ignored":"PRIVATE"}}',
  [daemon]: '{"pid":4029,"startedAt":123,"servingAt":124,"inflightCount":0,"filesKeyId":"PRIVATE","generation":2}',
};
function fixture(files = installed, running = () => true) {
  const reads = [], pids = [];
  return { reads, pids, accessibility: () => undefined, home: '/home', running: pid => { pids.push(pid); return running(pid); },
    read: path => {
      reads.push(path);
      assert.ok([systemPlist, userPlist, gate, settings, daemon].includes(path), `forbidden read: ${path}`);
      if (!(path in files)) throw Object.assign(new Error('PRIVATE'), { code: 'ENOENT' });
      if (files[path] instanceof Error) throw files[path];
      return files[path];
    },
  };
}

test('reports the bundle version and separate computer-use, daemon and permission states', { skip: macCommandSkip('plutil') }, () => {
  const io = fixture();
  const status = grokbotStatus(io);
  assert.equal(status.version, '0.71.2');
  assert.equal(status.computerUse, false);
  assert.equal(status.daemonRunning, true);
  assert.equal(status.localToolPermission, 'always');
  assert.deepEqual(io.pids, [4029]);
  assert.deepEqual(io.reads, [systemPlist, gate, settings, daemon]);
  const text = grokbotDoctorLines(status).join('\n');
  assert.match(text, /Grok Bot 0\.71\.2, computer use off, route: shell \(sleight-mcp js\)/);
  assert.match(text, /local daemon.*running.*PID/);
  assert.match(text, /local tool permission: always/);
  assert.doesNotMatch(JSON.stringify(status) + text, /PRIVATE|mcpBoxServers|filesKeyId/);
});

test('warns about a second driver only when Grok computer use is on', () => {
  const off = grokbotDoctorLines(grokbotStatus(fixture())).join('\n');
  assert.doesNotMatch(off, /second driver/);
  const on = grokbotDoctorLines(grokbotStatus(fixture({ ...installed, [gate]: '{"isOn":true}' }))).join('\n');
  assert.match(on, /computer use on/);
  assert.match(on, /second driver/);
});

test('finds a user-installed bundle when the system bundle is absent', { skip: macCommandSkip('plutil') }, () => {
  const files = { ...installed, [userPlist]: plist('0.72.0') };
  delete files[systemPlist];
  const io = fixture(files);
  assert.equal(grokbotStatus(io).version, '0.72.0');
  assert.deepEqual(io.reads, [systemPlist, userPlist, gate, settings, daemon]);
});

test('reads the release from a binary bundle plist', { skip: macCommandSkip('plutil') }, () => {
  const binary = execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', '-', '--', '-'], { input: plist('0.71.2') });
  assert.equal(grokbotStatus(fixture({ ...installed, [systemPlist]: binary })).version, '0.71.2');
});

test('unreadable system bundle does not silently select another installation', () => {
  const io = fixture({ ...installed, [systemPlist]: Object.assign(new Error('PRIVATE'), { code: 'EACCES' }), [userPlist]: plist('0.72.0') });
  const status = grokbotStatus(io);
  assert.equal(status.version, undefined);
  assert.equal(status.installed, undefined);
  assert.ok(!io.reads.includes(userPlist));
  assert.doesNotMatch(grokbotDoctorLines(status).join('\n'), /PRIVATE|0\.72\.0|bundle not found/);
});

test('missing metadata stays unknown and never probes a PID', () => {
  const io = fixture({});
  const status = grokbotStatus(io);
  assert.equal(status.installed, false);
  assert.equal(status.computerUse, undefined);
  assert.equal(status.localToolPermission, undefined);
  assert.equal(status.daemonRunning, undefined);
  assert.deepEqual(io.pids, []);
  const text = grokbotDoctorLines(status).join('\n');
  assert.match(text, /bundle not found/);
  assert.match(text, /computer use unknown, route: shell \(sleight-mcp js\)/);
  assert.match(text, /local daemon: unknown/);
  assert.match(text, /local tool permission: unknown/);
});

test('stale daemon PID reports stopped without changing the computer-use setting', () => {
  const status = grokbotStatus(fixture(installed, () => false));
  assert.equal(status.daemonRunning, false);
  assert.equal(status.computerUse, false);
  assert.match(grokbotDoctorLines(status).join('\n'), /local daemon: not running/);
});

test('failed liveness check and unreadable files report unknown without exposing errors', () => {
  const privateError = Object.assign(new Error('PRIVATE'), { code: 'EACCES' });
  const status = grokbotStatus(fixture({ ...installed, [gate]: privateError, [settings]: privateError }, () => { throw privateError; }));
  assert.equal(status.computerUse, undefined);
  assert.equal(status.localToolPermission, undefined);
  assert.equal(status.daemonRunning, undefined);
  const text = grokbotDoctorLines(status).join('\n');
  assert.match(text, /computer use unknown/);
  assert.match(text, /local daemon: unknown/);
  assert.doesNotMatch(text, /PRIVATE/);
});

test('malformed metadata never becomes an off setting or a running daemon', () => {
  for (const value of ['{', 'null', '[]', '"PRIVATE"', '{"isOn":"false","localToolPermission":"always\\nPRIVATE","pid":"4029"}']) {
    const io = fixture({ [systemPlist]: 'not a plist', [gate]: value, [settings]: value, [daemon]: value });
    const status = grokbotStatus(io);
    assert.equal(status.version, undefined);
    assert.equal(status.computerUse, undefined);
    assert.equal(status.localToolPermission, undefined);
    assert.equal(status.daemonRunning, undefined);
    assert.deepEqual(io.pids, []);
    assert.doesNotMatch(grokbotDoctorLines(status).join('\n'), /PRIVATE/);
  }
});

test('rejects unsafe PIDs before checking liveness', () => {
  for (const pid of [0, -1, 1.5, '4029', null, 2147483648]) {
    const io = fixture({ ...installed, [daemon]: JSON.stringify({ pid }) });
    assert.equal(grokbotStatus(io).daemonRunning, undefined);
    assert.deepEqual(io.pids, []);
  }
});

test('keeps raw bundle values and unknown permission values out of doctor output', () => {
  const status = grokbotStatus(fixture({ ...installed, [systemPlist]: plist('PRIVATE'), [settings]: '{"localToolPermission":"PRIVATE"}' }));
  assert.equal(status.version, undefined);
  assert.equal(status.localToolPermission, undefined);
  assert.doesNotMatch(grokbotDoctorLines(status).join('\n'), /PRIVATE/);
});

test('launcher prints Grok Bot metadata before unavailable engine discovery stops doctor', { skip: macCommandSkip('plutil') }, async () => {
  const lines = [], io = fixture();
  const code = await doctor({ settings: () => [], env: { CODEX_HOME: '/no-such-sleight-home', SLEIGHT_CHATGPT_APP: '/no-such-ChatGPT.app' },
    turbo: async () => [], hand: async () => [], permissions: async () => [], codex: () => [], cursor: () => [], grok: () => [],
    grokbot: () => grokbotDoctorLines(grokbotStatus(io)), log: line => lines.push(line),
  });
  assert.equal(code, 1);
  assert.match(lines[0], /^sleight \d+\.\d+\.\d+$/);
  assert.match(lines[1], /Grok Bot 0\.71\.2, computer use off, route: shell \(sleight-mcp js\)/);
  assert.match(lines.join('\n'), /local tool permission: always/);
});


test('doctor reports native helper Accessibility trust for this process tree with injected readers', () => {
  for (const trust of [true, false, undefined]) {
    let calls = 0;
    const status = grokbotStatus({ ...fixture(), accessibility: () => { calls++; return trust; } });
    assert.equal(calls, 1);
    const text = grokbotDoctorLines(status).join('\n');
    assert.match(text, /native helper Accessibility.*current process tree/);
    if (trust === true) assert.match(text, /Accessibility: granted/);
    else if (trust === false) assert.match(text, /Tell the owner.*responsible app.*Accessibility/);
    else assert.match(text, /Accessibility: unknown/);
    assert.doesNotMatch(text, /PRIVATE/);
  }
});

test('failed native trust readers stay unknown without leaking errors', () => {
  const status = grokbotStatus({ ...fixture(), accessibility: () => { throw new Error('PRIVATE'); } });
  assert.match(grokbotDoctorLines(status).join('\n'), /Accessibility: unknown/);
  assert.doesNotMatch(grokbotDoctorLines(status).join('\n'), /PRIVATE/);
});


test('trust reader invokes the existing helper without a prompt flag or an app target', () => {
  for (const trusted of [true, false]) {
    assert.equal(readNativeAccessibility({ exec: (command, args, options) => {
      assert.equal(command, '/usr/bin/osascript');
      assert.deepEqual(args.slice(0, 2), ['-l', 'JavaScript']);
      assert.ok(args[2].endsWith('/app-health.js'));
      assert.equal(args[3], '--accessibility-check');
      assert.equal(args.length, 4);
      assert.equal(options.timeout, 3000);
      return JSON.stringify({ trusted });
    } }), trusted);
  }
  assert.equal(readNativeAccessibility({ exec: () => '{"trusted":"yes"}' }), undefined);
});

test('native helper trust mode calls only AXIsProcessTrusted with no options', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/app-health.js', import.meta.url), 'utf8');
  for (const trusted of [true, false]) {
    let calls = 0;
    const result = runInNewContext(source + '; run(["--accessibility-check"])', {
      ObjC: { import: () => {} }, $: { AXIsProcessTrusted: (...args) => {
        assert.deepEqual(args, []); calls++; return trusted;
      } },
    });
    assert.equal(JSON.parse(result).trusted, trusted);
    assert.equal(calls, 1);
  }
});


test('doctor uses live session trust instead of the caller and never starts a session', async () => {
  for (const trust of [true, false, undefined]) {
    const status = await grokbotSessionStatus({ metadata: () => ({ nativeAccessibility: !trust }),
      session: async () => ({ ready: true, nativeAccessibility: trust }) });
    assert.equal(status.nativeAccessibility, trust);
    assert.match(grokbotDoctorLines(status).join('\n'), /live shell session/);
  }
  const status = await grokbotSessionStatus({ metadata: () => ({ nativeAccessibility: true }),
    session: async () => { throw new Error('PRIVATE'); } });
  assert.equal(status.nativeAccessibility, undefined);
  assert.doesNotMatch(grokbotDoctorLines(status).join('\n'), /PRIVATE/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, unlinkSync, renameSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';

test('CHV4N frozen live harness loses its backdrop within one second of owner return or parent exit without polling',
  { skip: process.platform !== 'darwin' }, async t => {
    const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'stage-watch-')));
    const fixture = readFileSync(new URL('../bench/hand/stage-fixture.swift', import.meta.url), 'utf8');
    let source = fixture.split('// BEGIN BACKDROP LIFECYCLE')[1].split('// END BACKDROP LIFECYCLE')[0];
    const mutations = {
      'no-file-watch': ['fileSource.setEventHandler { [weak self] in self?.end() }', 'fileSource.setEventHandler {}'],
      'no-folder-watch': ['folderSource.setEventHandler { [weak self] in self?.end() }', 'folderSource.setEventHandler {}'],
      'no-parent-watch': ['parentSource.setEventHandler { [weak self] in self?.end() }', 'parentSource.setEventHandler {}'],
      'poll-owner': ['source.schedule(deadline: .now() + timeoutSeconds,', 'source.schedule(deadline: .now() + timeoutSeconds, repeating: 1,'],
    };
    const variant = process.env.CHV4N_WATCH_BROKEN;
    if (variant) {
      const [before, after] = mutations[variant]; assert.ok(source.includes(before), 'mutation site ' + variant);
      source = source.replace(before, after);
    }
    assert.doesNotMatch(source, /repeating:|asyncAfter|sleep\(/, 'the fixture has no repeating timer or owner poll');
    const main = join(root, 'main.swift'), binary = join(root, 'watch');
    writeFileSync(main, `import Foundation\nimport Darwin\n${source}
final class Window: StageBenchSurfaceWindow {
    var surfaceLevel = 0, ignoresMouseEvents = false
    func surfaceFront() {}
    func surfaceOut() { print("out"); fflush(stdout) }
}
let surface = StageBenchSurface(backdrop: Window(), targets: [Window()], normal: 0, character: 3)
let marker = CommandLine.arguments[1]
precondition(surface.begin(timeoutSeconds: 2, ownerAwayFile: marker))
print("ready " + surface.wakeSources.sorted().joined(separator: ",")); fflush(stdout)
surface.didEnd = { print("ended"); fflush(stdout); exit(0) }
RunLoop.main.run()
`);
    const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), main, '-o', binary],
      { encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL' });
    assertChildStatus(built, 0, built.stderr);
    const harness = join(root, 'parent.mjs');
    // The harness is stopped with SIGSTOP after readiness and resumed for owned cleanup. Its child does not read stdin,
    // so parent-exit coverage cannot accidentally pass through the protocol EOF cleanup.
    writeFileSync(harness, `import { spawn } from 'node:child_process';
const child = spawn(process.argv[2], [process.argv[3]], { stdio: ['ignore', 'inherit', 'inherit'] });
child.once('error', () => process.exit(70));
process.stdin.resume(); process.stdin.once('end', () => process.exit(0));
`);
    for (const action of ['delete-file', 'rename-file', 'delete-folder', 'rename-folder', 'parent-exit']) {
      const folder = join(root, action); mkdirSync(folder);
      const marker = join(folder, 'away'); writeFileSync(marker, '');
      const parent = spawn(process.execPath, [harness, binary, marker], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', error = '', ready, frozen = false;
      const started = new Promise(resolve => { ready = resolve; });
      const finished = new Promise(resolve => parent.once('close', (code, signal) => resolve({ code, signal })));
      parent.stderr.on('data', bytes => { error += bytes; });
      parent.stdout.on('data', bytes => {
        output += bytes;
        if (output.includes('ready ')) ready();
        if (output.includes('ended')) {
          if (frozen) { parent.kill('SIGCONT'); frozen = false; }
          parent.stdin.end();
        }
      });
      let deadline;
      try {
        await Promise.race([started, new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('watch startup: ' + error)), 5000); })]);
        clearTimeout(deadline);
        assert.match(output, /ready exposure-deadline,owner-file,owner-folder,parent-exit/);
        if (action !== 'parent-exit') { assert.equal(parent.kill('SIGSTOP'), true); frozen = true; }
        const began = performance.now();
        if (action === 'delete-file') unlinkSync(marker);
        if (action === 'rename-file') renameSync(marker, marker + '-moved');
        if (action === 'delete-folder') { unlinkSync(marker); rmdirSync(folder); }
        if (action === 'rename-folder') renameSync(folder, folder + '-moved');
        if (action === 'parent-exit') parent.stdin.end();
        const result = await finished;
        const elapsedMs = performance.now() - began;
        assert.equal(result.code, 0, error); assert.equal(result.signal, null, error);
        assert.match(output, /out\nended/); assert.ok(elapsedMs < 1000, action + ' took ' + elapsedMs + ' ms');
        t.diagnostic(action + ' lowered in ' + elapsedMs.toFixed(2) + ' ms; frozen=' + (action !== 'parent-exit') + ', windows=0, fixture repeating timers=0');
      } finally {
        clearTimeout(deadline);
        if (frozen) parent.kill('SIGCONT');
        parent.stdin.end(); await finished;
      }
    }
  });

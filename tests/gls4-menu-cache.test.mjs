import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { recordedFixture, calculatorTree, excelTree } from './fixtures/mac-driver-recorded-tree.mjs';

test('menu cache equals a live walk, including mutations invisible to the bar', { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-gls4-cache-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  let source = macDriverSource().replace(/\ndriverMain\(\)\s*$/, '\n')
    .replace('let fixture: DriverObject?', 'var fixture: DriverObject?');
  // Mutants are compiled only into this private fixture and run independently.
  const variants = {
    digest: ['snapshot.matches(cached.snapshot)', '(gls4Mutation == "digest" || snapshot.matches(cached.snapshot))'],
    pid: ['pid == other.pid', '(gls4Mutation == "pid" || pid == other.pid)'],
    start: ['processStart == other.processStart', '(gls4Mutation == "start" || processStart == other.processStart)'],
    requests: ['requests == other.requests', '(gls4Mutation == "requests" || requests == other.requests)'],
    identity: ['zip(nodes, other.nodes).allSatisfy { $0.node.same($1.node) }', '(gls4Mutation == "identity" || zip(nodes, other.nodes).allSatisfy { $0.node.same($1.node) })'],
    strict: ['kAXSizeAttribute, "AXElementBusy"], request: request, strict: true)', 'kAXSizeAttribute, "AXElementBusy"], request: request, strict: gls4Mutation != "strict")'],
    secure: ['roles[kAXSubroleAttribute] as? String != "AXSecureTextField"', '(gls4Mutation == "secure" || roles[kAXSubroleAttribute] as? String != "AXSecureTextField")'],
    'submenu-count': ['[identity, depth, children.0.count, count, appleExpanded, submenuExpanded,', '[identity, depth, children.0.count, gls4Mutation == "submenu-count" ? 0 : count, appleExpanded, submenuExpanded,'],
    seen: ['return !(seen[hash] ?? []).contains(where: { $0.same(row.node) })', 'return gls4Mutation == "seen" || !(seen[hash] ?? []).contains(where: { $0.same(row.node) })'],
    budget: ['bytes <= 1_048_576 - capturedBytes', '(gls4Mutation == "budget" || bytes <= 1_048_576 - capturedBytes)'],
    'action-limit': ['actions.count <= 256', '(gls4Mutation == "action-limit" || actions.count <= 256)'],
    depth: ['depth <= 64', '(gls4Mutation == "depth" || depth <= 64)'],
    nodes: ['nodes.count < 3000', '(gls4Mutation == "nodes" || nodes.count < 3000)'],
    roles: ['["AXMenuBar", "AXMenuBarItem", "AXMenu", "AXMenuItem"].contains(role)', '(gls4Mutation == "roles" || ["AXMenuBar", "AXMenuBarItem", "AXMenu", "AXMenuItem"].contains(role))'],
    types: ['!identity.values.contains("unsupported")', '(gls4Mutation == "types" || !identity.values.contains("unsupported"))'],
    deadline: ['ProcessInfo.processInfo.systemUptime < (request.walkDeadline ?? request.deadline)', '(gls4Mutation == "deadline" || ProcessInfo.processInfo.systemUptime < (request.walkDeadline ?? request.deadline))'],
  };
  const cacheStart = source.indexOf('// Source: DriverMenuCache.swift'); assert.ok(cacheStart > 0);
  for (const [before, after] of Object.values(variants)) {
    const tail = source.slice(cacheStart);
    assert.ok(tail.includes(before), 'mutation anchor'); source = source.slice(0, cacheStart) + tail.replace(before, after);
  }
  source = source.replace('if let forbidden = fake["forbidReads"]', 'if fake["forbidReads"] != nil && names.contains("AXValue") { gls4ProtectedReads += 1 }\n            if let forbidden = fake["forbidReads"]');
  // Expire exactly after the final AX read, without a clock race or live app.
  const completedWalk = 'guard try walk(root, depth: 0),';
  assert.ok(source.includes(completedWalk));
  source = source.replace(completedWalk, 'let walked = try walk(root, depth: 0)\n        if request.params["gls4Expire"] as? Bool == true { request.walkDeadline = ProcessInfo.processInfo.systemUptime - 1 }\n        guard walked,');
  source += '\nlet gls4Mutation = ProcessInfo.processInfo.environment["GLS4_CACHE_MUTANT"] ?? ""\nvar gls4ProtectedReads = 0\n';
  const path = join(root, 'cache.swift'), binary = join(root, 'cache');
  const records = join(root, 'records.json');
  const glc1 = await readFile(new URL('./fixtures/glc1-calculator-closed.txt', import.meta.url), 'utf8');
  await writeFile(records, JSON.stringify([glc1, calculatorTree, excelTree].map(text => recordedFixture(text))));
  await writeFile(path, source + await readFile(new URL('./fixtures/gls4-menu-cache.swift', import.meta.url), 'utf8'));
  const compiled = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), path, '-o', binary],
    { timeout: 240000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 65536 });
  assert.equal(compiled.status, 0, compiled.stderr);
  const result = spawnSync(binary, [records], { timeout: 30000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 65536 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const rows = result.stdout.trim().split('\n').map(JSON.parse);
  for (const row of rows) { assert.equal(row.pass, true, row.name); t.diagnostic(JSON.stringify(row)); }
  for (const variant of Object.keys(variants)) {
    const broken = spawnSync(binary, [records], { env: { ...process.env, GLS4_CACHE_MUTANT: variant },
      timeout: 30000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 65536 });
    assert.equal(broken.status, 1, variant + ': ' + broken.stdout + broken.stderr);
    const failed = broken.stdout.trim().split('\n').map(JSON.parse).filter(row => !row.pass);
    assert.ok(failed.length > 0, variant);
    t.diagnostic(`broken variant=${variant} failureCount=${failed.length} exit=${broken.status}`);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

test('production driverRect accepts native and JSON numbers and rejects invalid coordinates', {
  skip: process.platform !== 'darwin', timeout: 300000,
}, async t => {
  const tree = await readFile(new URL('../plugins/sleight/lib/mac-driver/native/DriverTree.swift', import.meta.url), 'utf8');
  const helpers = tree.slice(tree.indexOf('func driverCoordinate('), tree.indexOf('func driverSameBounds('));
  assert.match(helpers, /func driverRect/);
  const variants = [
    ['original', helpers],
    ['old-double-cast', helpers.replace('let x = driverCoordinate(b["x"]), let y = driverCoordinate(b["y"]),', 'let x = b["x"] as? Double, let y = b["y"] as? Double,')],
    ['allows-bool', helpers.replace('CFGetTypeID(number) != CFBooleanGetTypeID(), ', '')],
    ['allows-nonfinite', helpers.replace('number.doubleValue.isFinite', 'true').replace('float.isFinite', 'true')],
  ];
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-bounds-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'bounds.swift'), binary = join(root, 'bounds');
  const functions = variants.map(([name, code], i) => {
    if (i) assert.notEqual(code, helpers, name);
    return code.replaceAll('driverCoordinate', `coordinate${i}`).replaceAll('driverRect', `rect${i}`);
  }).join('\n');
  await writeFile(source, `import Foundation\nimport CoreGraphics\nimport CoreFoundation\ntypealias DriverObject = [String: Any]\n${functions}
let functions: [(Any?) -> CGRect?] = [${variants.map((_, i) => `rect${i}`).join(', ')}]
let index = Int(CommandLine.arguments[1])!
let rect = functions[index]
var checks = 0, failures = 0
func expect(_ value: Bool) { checks += 1; if !value { failures += 1 } }
let valid: [Any] = [CGFloat(12.5), Double(12.5), Int(12), NSNumber(value: 12.5)]
let invalid: [Any] = [true, false, NSNumber(value: true), Double.nan, Double.infinity, -Double.infinity, CGFloat.nan, CGFloat.infinity, NSNumber(value: Double.nan), NSNumber(value: Double.infinity), "12", NSNull()]
for key in ["x", "y", "width", "height"] {
    for value in valid {
        var fields: DriverObject = ["x": 0.0, "y": 0.0, "width": 30.0, "height": 40.0]; fields[key] = value
        if let bounds = rect(fields) {
            let values = ["x": bounds.origin.x, "y": bounds.origin.y, "width": bounds.width, "height": bounds.height]
            let expected = (value as? NSNumber)?.doubleValue ?? Double(value as! CGFloat)
            expect(Double(values[key]!) == expected)
        } else { expect(false) }
    }
    for value in invalid {
        var fields: DriverObject = ["x": 0.0, "y": 0.0, "width": 30.0, "height": 40.0]; fields[key] = value
        expect(rect(fields) == nil)
    }
}
expect(rect(nil) == nil); expect(rect(["x": 1]) == nil)
print("checks=\\(checks) failures=\\(failures)")
exit(failures == 0 ? 0 : 1)
`);
  const compiled = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), source, '-o', binary], {
    encoding: 'utf8', timeout: 240000, killSignal: 'SIGKILL', maxBuffer: 65536,
  });
  assert.equal(compiled.status, 0, compiled.stderr);
  for (const [i, [name]] of variants.entries()) await t.test(name, () => {
    const run = spawnSync(binary, [String(i)], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
    assert.equal(run.status, i === 0 ? 0 : 1, run.stdout + run.stderr);
    assert.match(run.stdout, /checks=66 failures=\d+/);
    t.diagnostic(`${name}: ${run.stdout.trim()}; exit=${run.status}`);
  });
});

test('identity candidates fault contains only its fixed step', async () => {
  const tree = await readFile(new URL('../plugins/sleight/lib/mac-driver/native/DriverTree.swift', import.meta.url), 'utf8');
  const line = tree.split('\n').find(line => line.includes('step=candidates'));
  assert.match(line, /"IDENTITY_UNVERIFIED step=candidates"\)/);
  assert.doesNotMatch(line, /nodes=|exact=|fallback=|bounds=/);
});

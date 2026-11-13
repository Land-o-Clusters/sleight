import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { macCommandSkip } from './requirements.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

test('CH-2 the planned panel contains the art and survives observed AppKit whole-point rounding', { skip: macCommandSkip('xcrun') }, t => {
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  const start = source.indexOf('func stagePanelFrameAccepted('), end = source.indexOf('// BEGIN SPRITE DRAWING BOUNDS', start);
  assert.ok(start > 0 && end > start);
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-panel-quantization-'))));
  const code = join(root, 'panel.swift'), binary = join(root, 'panel');
  writeFileSync(code, `import Foundation
import CoreGraphics
struct Seat { var usable: CGRect?; var display: CGRect }
struct PerchPlan { var positions: [(Double, CGPoint)]; var seat: Seat }
struct PerchMetrics { var size: CGSize }
${source.slice(start, end)}
let usable = CGRect(x: 0, y: 33, width: 1512, height: 949)
// The first two rectangles are the actual live mismatch cases in top-left coordinates.
let samples = [CGRect(x: 0, y: 34.01, width: 192, height: 208),
    CGRect(x: 0, y: 34.01, width: 356.49391304347824, height: 386.20173913043476),
    CGRect(x: -800.25, y: 52.75, width: 192, height: 208)]
let rows = samples.map { art -> [String: Any] in
    let space = art.minX < 0 ? usable.offsetBy(dx: -1512, dy: 0) : usable
    let plan = PerchPlan(positions: [(0, art.origin)], seat: Seat(usable: space, display: space))
    let panel = stagePanelBounds(plan, PerchMetrics(size: art.size))
    let target = CGRect(x: panel.minX, y: 982 - panel.maxY, width: panel.width, height: panel.height)
    let observed = CGRect(x: floor(target.minX), y: floor(target.minY), width: ceil(target.width), height: ceil(target.height))
    return ["panel": [panel.minX,panel.minY,panel.width,panel.height],
        "accepted": stagePanelFrameAccepted(target: target, actual: observed), "containsArt": panel.contains(art),
        "usable": space.contains(panel), "shiftAccepted": stagePanelFrameAccepted(target: target, actual: target.offsetBy(dx: 1, dy: 0))]
}
print(String(data: try! JSONSerialization.data(withJSONObject: rows), encoding: .utf8)!)
`);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), code, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(run, 0, run.stderr);
  for (const row of JSON.parse(run.stdout)) {
    assert.equal(row.accepted, true, JSON.stringify(row)); assert.equal(row.containsArt, true);
    assert.equal(row.usable, true); assert.equal(row.shiftAccepted, false, 'a real frame displacement still hides');
  }
});

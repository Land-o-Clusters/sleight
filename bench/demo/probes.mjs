import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function importSpriteProbe(at, rect, bounds, manifest) {
  const w = manifest.frame.w * manifest.scale, h = manifest.frame.h * manifest.scale;
  return { region: [at[0] + 18 + w <= bounds[0] + bounds[2] ? at[0] + 18 : at[0] - 18 - w,
    at[1] + 18 + h <= bounds[1] + bounds[3] ? at[1] + 18 : at[1] - 18 - h, w, h],
  exclude: [rect[0] - 30, rect[1] - 30, rect[2] + 60, rect[3] + 60] };
}

// Probes use the owned recorder's crop at one pixel per fixture point. Regions exclude the moving tile and counters.
export function pixelDelta(base, sample, width, height, region, kind, exclude) {
  if (base.length !== width * height * 3 || sample.length !== base.length || !region?.every(Number.isFinite)) throw Error('Invalid drawing probe');
  let changed = 0, painted = 0;
  const [x, y, w, h] = region;
  for (let py = Math.max(0, Math.ceil(y)); py < Math.min(height, y + h); py++) {
    for (let px = Math.max(0, Math.ceil(x)); px < Math.min(width, x + w); px++) {
      if (exclude && px > exclude[0] && py > exclude[1] && px < exclude[0] + exclude[2] && py < exclude[1] + exclude[3]) continue;
      const i = (py * width + px) * 3, [r, g, b] = sample.subarray(i, i + 3);
      if (Math.max(...[r, g, b].map((v, c) => Math.abs(v - base[i + c]))) < 24) continue;
      changed++;
      // A bubble must change neutral pixels as well as its outline. Ring and sprite require coloured ink.
      if (kind === 'bubble' ? Math.max(r, g, b) - Math.min(r, g, b) < 24 : Math.max(r, g, b) - Math.min(r, g, b) >= 32) painted++;
    }
  }
  return { kind, changed, painted, region, ...(exclude ? { exclude } : {}), passed: painted >= (kind === 'bubble' ? 80 : 24) };
}

export function requiredProbes(id) {
  return ['ring', ...(['03-tsugi', '03-kit', '05-picker', '06-import'].includes(id) ? ['sprite'] : []),
    ...(id === '04-narration' ? ['bubble'] : [])];
}

export async function verifyDrawing(children, directory, shot, capture) {
  const { width, height, baselineAt, samples } = capture.probePlan;
  const first = Date.parse(capture.wallClockStart);
  if (!Number.isFinite(first)) throw Error('Missing recorder clock for drawing probes');
  const frame = async (at, name) => {
    const seconds = (at - first) / 1000;
    if (!(seconds >= 0 && seconds < capture.seconds)) throw Error('Drawing probe outside recording');
    const path = join(directory, `probe-${name}.rgb`);
    await children.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', '-filter_threads', '1',
      '-i', join(directory, 'take.mov'), '-ss', seconds.toFixed(3), '-frames:v', '1', '-vf', `scale=${width}:${height}`,
      '-threads', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', path]);
    return readFileSync(path);
  };
  const base = await frame(baselineAt, 'baseline'), results = [];
  for (const kind of requiredProbes(shot.id)) {
    const sample = samples.find(s => s.kind === kind);
    if (!sample) throw Error(`No ${kind} drawing probe`);
    results.push(pixelDelta(base, await frame(sample.at, kind), width, height, sample.region, kind, sample.exclude));
  }
  const passed = results.every(r => r.passed);
  if (!passed) throw Object.assign(Error(`Drawing absent: ${results.filter(r => !r.passed).map(r => `${r.kind}=${r.painted}`).join(', ')}`),
    { probes: { passed, baselineAt, results } });
  return { passed, baselineAt, results };
}

import { createHash } from 'node:crypto';

// Only dependencies of the plan/label contract invalidate the VM reference.
export const windowsPlannerRegions = Object.freeze(['HAND FRAME', 'HAND MOTION', 'RING PLAN', 'RING RUNTIME', 'SPRITE']);
export function windowsPlannerSource(source) {
  const text = String(source);
  return windowsPlannerRegions.map(name => {
    const start = text.indexOf('// BEGIN ' + name + '\n'), marker = '// END ' + name;
    const end = text.indexOf(marker + '\n', start);
    if (start < 0 || end < start) throw Error('Missing Swift planner region: ' + name);
    return text.slice(start, end + marker.length);
  }).join('\n');
}
export const windowsPlannerHash = source => createHash('sha256').update(windowsPlannerSource(source)).digest('hex');

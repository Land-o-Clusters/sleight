// Shared by the scheduler and its visible control. Targets are protected rectangles, never the drawing's own box.
export function countOverlaps(plan, targets, sweeps, hit) {
  let overlaps = 0, pairs = 0, segments = 0;
  for (const box of sweeps(plan)) {
    segments++;
    for (const target of targets) {
      pairs++;
      if (hit(box, target)) overlaps++;
    }
  }
  return { overlaps, pairs, segments };
}

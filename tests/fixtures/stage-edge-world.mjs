// Shared screen-edge geometry fixtures. Widening runs in the production host.
export const expandWindow = r => [r[0] - 48, r[1] - 48, r[2] + 96, r[3] + 96];
export const edgeWindow = { id: 7, pid: 42, frame: [0, 400, 1800, 400] };
export function edgeWorld({ bottom = false, ...more } = {}) {
  const window = { ...edgeWindow, frame: bottom ? [0, 30, 1800, 770] : [0, 400, 1800, 770] };
  return { dumpWorld: { windows: [window], displays: [{ frame: [0, 0, 1800, 1200], visible: [0, 30, 1800, 1140] }],
    person: [1700, 1000, 80, 100], pointer: [1790, 1190], inputAge: 20, pointerAway: 10,
    cards: [expandWindow(window.frame)], ...more } };
}

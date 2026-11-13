const bounds = { x: -200, y: 100, width: 400, height: 300 };
export const fakeInventory = {
  apps: [{ id: 'test.pointer', name: 'Fixture', pid: 321, processStart: 'fake-start' }],
  windows: [{ windowId: '42', pid: 321, processStart: 'fake-start', bundleId: 'test.pointer', app: 'Fixture',
    title: 'Fixture', bounds, onScreen: true, layer: 0, hidden: false, identityVerified: true }],
  trees: { 42: { AXRole: 'AXWindow', AXTitle: 'Fixture', AXMinimized: false, AXFullScreen: false, pid: 321, frame: bounds, children: [
    { AXRole: 'AXButton', AXTitle: 'Press', AXIdentifier: 'press', pid: 321, frame: { x: -180, y: 120, width: 40, height: 20 } },
  ] } },
};
export const coordinate = { coordinateTest: true, withCapture: true, args: [[80, 60]] };
export const button = { ...fakeInventory.trees[42].children[0], AXParent: { AXRole: 'AXWindow', pid: 321 } };
export const changedTargets = [
  ['list scroll', { hit: { ...button, AXTitle: 'Another row' } }],
  ['sheet with the same label', { hit: button, hitPath: '42/sheet/ok' }],
  ['same-app overlay', { hit: { ...button, AXRole: 'AXGroup' } }],
  ['identical pixels and changed state', { hit: { ...button, AXSelected: true }, pixelsMatch: true }],
  ['target moved 60 points', { hit: { ...button, frame: { ...button.frame, y: button.frame.y + 60 } } }],
  ['changed at the posting boundary', { hitAfter: { ...button, AXTitle: 'Changed during prepare' } }],
  ['partial delivered map', { partialMap: true }],
  ['expired delivered map', { params: { coordinateReadId: 99 } }],
];
export const coordinateReplayCases = () => [
  ...changedTargets.map(([name, input]) => ({ name, input: { fixture: fakeInventory, ...coordinate, ...input }, code: 'TARGET_CHANGED' })),
  { name: 'unchanged button', input: { fixture: fakeInventory, ...coordinate } },
  ...[false, true].map(pixelsMatch => {
    const fixture = structuredClone(fakeInventory); fixture.trees[42].children[0].AXRole = 'AXCanvas';
    return { name: `canvas pixels=${pixelsMatch}`, input: { fixture, ...coordinate, pixelsMatch }, ...!pixelsMatch ? { code: 'TARGET_CHANGED' } : {} };
  }),
];

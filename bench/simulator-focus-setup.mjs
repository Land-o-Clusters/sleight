// Probe-only launch ownership, separate from the shared benchmark setup.
export function simulatorFocusProbeOptions({ env = process.env, check, observe }) {
  return {
    relayOptions: { simFocusNote: env.SLEIGHT_SIM_FOCUS_NOTE === '1' },
    async permissionCheck() { check(); return observe({ check, stopOnLiveHold: true }); },
  };
}

export function launchSimulatorFocus(ctx, { viewer, simctl, check, beginLaunch, openViewer, record }) {
  // openFixture's retained native helper reports this before its launch callback runs.
  if (viewer?.running === true) throw new Error('Simulator viewer already running; stopped before boot');
  if (viewer?.running !== false) throw new Error('Simulator viewer ownership is unconfirmed; stopped before boot');
  check();
  const devices = Object.values(JSON.parse(simctl('list', 'devices', 'available', '--json')).devices).flat()
    .filter(device => device.name.startsWith('iPhone'));
  if (devices.some(device => device.state === 'Booted')) throw new Error('An iPhone is already booted; stopped');
  const device = devices.find(device => device.state === 'Shutdown');
  if (!device || typeof device.udid !== 'string' || !device.udid) throw new Error('No shutdown iPhone is available; stopped');
  // Publish ownership before the boot command, which can fail after starting the device.
  ctx.sim = { udid: device.udid, name: device.name, app: viewer.app, bootedByTask: true, bootAttempted: false };
  check(); ctx.sim.bootAttempted = true;
  record?.(ctx.sim);
  simctl('boot', device.udid);
  check(); simctl('bootstatus', device.udid, '-b');
  check(); beginLaunch(true);
  check(); openViewer();
  return ctx.sim;
}

export function shutdownSimulatorFocus(ctx, { simctl, check, record }) {
  if (!ctx.sim?.bootAttempted || ctx.sim.bootShutdownConfirmed) return;
  check(); simctl('shutdown', ctx.sim.udid);
  ctx.sim.bootShutdownConfirmed = true;
  record?.(ctx.sim);
}

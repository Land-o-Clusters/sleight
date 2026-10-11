import base from 'node:test';

// sleight drives macOS apps. These files call osascript, xcrun or plutil, or make folders under
// /private/tmp, none of which exist on the Linux CI runner (36 failures there for 1.2.0). Elsewhere each
// test is listed as skipped, by name.
export const test = process.platform === 'darwin' ? base
  : Object.assign(name => base(name, { skip: 'macOS only' }, () => {}), base);
export default test;

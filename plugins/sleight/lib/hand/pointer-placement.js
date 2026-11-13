// osascript bootstrap for the two repository-owned pointer helpers. It draws nothing itself.
ObjC.import('Foundation');

function pointerPlacement(token, native) {
  let remaining = 100;
  return frame => {
    if (remaining <= 0) { native.write('sleight-place-timeout ' + token + '\n'); return false; }
    const began = native.now(), deadline = began + remaining;
    const parentDeadline = (native.wallNow ?? native.now)() + remaining;
    native.write('sleight-place ' + JSON.stringify({ token, frame, deadline: parentDeadline }) + '\n');
    let buffer = '';
    try {
      while (native.now() < deadline && native.ready(Math.max(0, deadline - native.now()))) {
        const chunk = native.read();
        if (!chunk) break;
        buffer += chunk;
        if (buffer.length > 1024) break;
        const end = buffer.indexOf('\n');
        if (end < 0) continue;
        const receipt = JSON.parse(buffer.slice(0, end));
        if (Object.keys(receipt).sort().join() === 'placed,stopped,token' && receipt.token === token && receipt.placed === false && receipt.stopped === true)
          throw Object.assign(new Error('Input lease: this call was stopped.'), { code: 'USER_STOPPED' });
        if (Object.keys(receipt).sort().join() === 'placed,token' && receipt.token === token && typeof receipt.placed === 'boolean')
          return receipt.placed;
        break;
      }
    } catch (error) { if (error.code === 'USER_STOPPED') throw error; }
    finally { remaining = Math.max(0, remaining - (native.now() - began)); }
    native.write('sleight-place-timeout ' + token + '\n');
    return false;
  };
}
function run(argv) {
  const [script, requestJSON, token] = argv;
  if (!/^\/[\s\S]*\/(drag|hover)\.js$/.test(script) || !/^[a-f0-9]{32}$/.test(token)) throw new Error('invalid pointer helper');
  ObjC.bindFunction('poll', ['int', ['void*', 'unsigned int', 'int']]);
  // Darwin pollfd: stdin, POLLIN. Poll always has a finite remaining deadline.
  const descriptor = $.NSData.alloc.initWithBase64EncodedStringOptions('AAAAAAEAAAA=', 0).mutableCopy;
  const sleightPlaceHand = pointerPlacement(token, {
    now: () => Number($.NSProcessInfo.processInfo.systemUptime) * 1000,
    wallNow: () => Date.now(),
    ready: ms => Number($.poll(descriptor.mutableBytes, 1, Math.floor(ms))) === 1,
    read: () => ObjC.unwrap($.NSString.alloc.initWithDataEncoding($.NSFileHandle.fileHandleWithStandardInput.availableData, $.NSUTF8StringEncoding)),
    write: line => $.NSFileHandle.fileHandleWithStandardError.writeData($(line).dataUsingEncoding($.NSUTF8StringEncoding)),
  });
  const source = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(script, $.NSUTF8StringEncoding, null));
  // Only launch.mjs selects script, from its fixed drag.js/hover.js paths. The request is data.
  return eval('(function (sleightPlaceHand) { ' + source + '\n; return run; })')(sleightPlaceHand)([requestJSON]);
}

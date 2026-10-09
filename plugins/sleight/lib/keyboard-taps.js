// Lists the event taps that can hold up the keyboard: enabled filter taps on key events, as JSON
// [{ pid, app, bundleId }]. Device Hub, left open after simulator runs, held one that stalled every
// key on the Mac for 40 s (2026-10-09). bench/keyboard-taps.swift is the benchmark's copy.
//   osascript -l JavaScript keyboard-taps.js
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
function run() {
  try {
    ObjC.bindFunction('CGGetEventTapList', ['int', ['unsigned int', 'void*', 'void*']]);
    ObjC.bindFunction('malloc', ['void*', ['unsigned long']]);
    ObjC.bindFunction('free', ['void', ['void*']]);
    // JXA has no atob, so the bytes come back through base64 decoded here.
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const bytes = (ptr, length) => {
      const b64 = ObjC.unwrap($.NSData.dataWithBytesLength(ptr, length).base64EncodedStringWithOptions(0)).replace(/=+$/, '');
      const out = new Uint8Array(length);
      let bits = 0, value = 0, n = 0;
      for (const c of b64) {
        value = (value << 6) | ALPHABET.indexOf(c); bits += 6;
        if (bits >= 8) { bits -= 8; out[n++] = (value >> bits) & 0xff; }
      }
      return out;
    };
    const countPtr = $.malloc(4);
    let list = [];
    try {
      if ($.CGGetEventTapList(0, null, countPtr)) throw new Error('CGGetEventTapList failed');
      const count = new DataView(bytes(countPtr, 4).buffer).getUint32(0, true);
      if (count) {
        const SIZE = 48; // CGEventTapInformation
        const taps = $.malloc(SIZE * count);
        try {
          if ($.CGGetEventTapList(count, taps, countPtr)) throw new Error('CGGetEventTapList failed');
          const view = new DataView(bytes(taps, SIZE * count).buffer);
          const KEYS = (1n << 10n) | (1n << 11n) | (1n << 12n); // key down, key up, flags changed
          for (let i = 0; i < count; i++) {
            const at = i * SIZE;
            const options = view.getUint32(at + 8, true), events = view.getBigUint64(at + 16, true);
            const pid = view.getInt32(at + 24, true), enabled = view.getUint8(at + 32) !== 0;
            if (!enabled || options !== 0 || !(events & KEYS)) continue;
            const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
            const known = app && !app.isNil();
            list.push({ pid, app: known ? ObjC.unwrap(app.localizedName) ?? '' : '', bundleId: known ? ObjC.unwrap(app.bundleIdentifier) ?? '' : '' });
          }
        } finally { $.free(taps); }
      }
    } finally { $.free(countPtr); }
    return JSON.stringify({ ok: true, taps: list });
  } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); }
}

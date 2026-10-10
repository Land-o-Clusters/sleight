// Read button state without posting input, changing focus or asking for permission.
ObjC.import('CoreGraphics');
function run() {
  try {
    const buttons = [];
    for (let button = 0; button < 32; button++) {
      if ($.CGEventSourceButtonState(0, button) || $.CGEventSourceButtonState(1, button)) buttons.push(button);
    }
    return JSON.stringify({ ok: true, buttons });
  } catch (error) { return JSON.stringify({ ok: false, error: String(error.message || error) }); }
}

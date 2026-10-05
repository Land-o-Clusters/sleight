// No posting or app control: exercise the production bridge before live trials.
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
function run() {
  try {
    ObjC.bindFunction('CGEventSetWindowLocation', ['void', ['id', '{CGPoint="x"d"y"d}']]);
    ObjC.bindFunction('CGEventGetWindowLocation', ['{CGPoint="x"d"y"d}', ['id']]);
    ObjC.bindFunction('objc_msgSend', ['id', ['id', 'selector']]);
    const native = $.NSEvent.mouseEventWithTypeLocationModifierFlagsTimestampWindowNumberContextEventNumberClickCountPressure(
      1, $.CGPointMake(20, 30), 1 << 20,
      $.NSProcessInfo.processInfo.systemUptime, 1, null, 0, 1, 1);
    const event = $.objc_msgSend(native, 'CGEvent');
    const initial = { native: String(native), event: String(event), type: $.CGEventGetType(event), initial: $.CGEventGetLocation(event) };
    $.CGEventSetLocation(event, $.CGPointMake(120, 130));
    $.CGEventSetWindowLocation(event, $.CGPointMake(20, 30));
    $.CGEventSetIntegerValueField(event, 7, 3);
    const plain = $.CGEventCreateMouseEvent(null, 1, $.CGPointMake(120, 130), 0);
    const local = $.CGEventGetWindowLocation(event), screen = $.CGEventGetLocation(event);
    return JSON.stringify({ ok: $.CGEventGetType(event) === 1 && local.x === 20 && local.y === 30 && screen.x === 120 && screen.y === 130,
      nativeType: native.type, ...initial, screen, local, plainType: $.CGEventGetType(plain), plain: $.CGEventGetLocation(plain) });
  } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); }
}

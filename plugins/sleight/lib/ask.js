// The app approval prompt sleight shows under the desktop app (see launch.mjs).
// JavaScript for Automation, so it needs no compiled helper:
//
//   osascript -l JavaScript ask.js <question> <detail> <icon.png> <seconds>
//
// Prints accept, decline (Don't Allow or Escape) or cancel (timed out). It uses
// Liquid Glass (NSGlassEffectView) where macOS has it, else a frosted
// NSVisualEffectView. Return does nothing, so a stray keypress can't approve.

ObjC.import('Cocoa');

function run(argv) {
  const [question, detail, iconPath, seconds] = argv;
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);

  let answer = 'cancel';
  const finish = value => () => {
    answer = value;
    app.stopModal;
  };
  ObjC.registerSubclass({
    name: 'SleightAskTarget',
    methods: {
      'allow:': { types: ['void', ['id']], implementation: finish('accept') },
      'deny:': { types: ['void', ['id']], implementation: finish('decline') },
      'giveUp:': { types: ['void', ['id']], implementation: finish('cancel') },
    },
  });
  const target = $.SleightAskTarget.alloc.init;

  const W = 400;
  const PAD = 20;
  const ICON = 56;
  const TEXT_X = PAD + ICON + 16;
  const TEXT_W = W - TEXT_X - PAD;
  const BUTTON_H = 28;

  // Measure the wrapped text first, so the panel fits it.
  const label = (text, font, color) => {
    const field = $.NSTextField.wrappingLabelWithString(text);
    field.font = font;
    field.textColor = color;
    field.preferredMaxLayoutWidth = TEXT_W;
    const size = field.sizeThatFits($.NSMakeSize(TEXT_W, 1000));
    return { field, height: Math.ceil(size.height) };
  };
  // Says who is asking, for people who never saw sleight's icon.
  const eyebrow = label('sleight \u00b7 Claude Code computer use', $.NSFont.systemFontOfSizeWeight(10, $.NSFontWeightMedium), $.NSColor.tertiaryLabelColor);
  const title = label(question, $.NSFont.systemFontOfSizeWeight(13, $.NSFontWeightSemibold), $.NSColor.labelColor);
  const body = label(detail, $.NSFont.systemFontOfSize(11), $.NSColor.secondaryLabelColor);
  const textH = eyebrow.height + 2 + title.height + 4 + body.height;
  const topH = Math.max(ICON, textH);
  const H = PAD + topH + 18 + BUTTON_H + PAD;

  const style = $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskFullSizeContentView;
  const panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(0, 0, W, H), style, $.NSBackingStoreBuffered, false);
  panel.titlebarAppearsTransparent = true;
  panel.titleVisibility = $.NSWindowTitleHidden;
  panel.movableByWindowBackground = true;
  panel.opaque = false;
  panel.backgroundColor = $.NSColor.clearColor;
  panel.level = $.NSModalPanelWindowLevel;
  panel.title = 'sleight';
  for (const b of [$.NSWindowCloseButton, $.NSWindowMiniaturizeButton, $.NSWindowZoomButton]) {
    panel.standardWindowButton(b).hidden = true;
  }
  // A titled window adds its titlebar on top of the content size. Size the
  // frame itself, so the content view is exactly W by H.
  panel.setFrameDisplay($.NSMakeRect(0, 0, W, H), false);

  const bounds = $.NSMakeRect(0, 0, W, H);
  const content = $.NSView.alloc.initWithFrame(bounds);
  if (typeof $.NSGlassEffectView === 'function') {
    const glass = $.NSGlassEffectView.alloc.initWithFrame(bounds);
    glass.cornerRadius = 22;
    glass.contentView = content;
    panel.contentView = glass;
  } else {
    const frost = $.NSVisualEffectView.alloc.initWithFrame(bounds);
    frost.material = $.NSVisualEffectMaterialHUDWindow;
    frost.blendingMode = $.NSVisualEffectBlendingModeBehindWindow;
    frost.state = $.NSVisualEffectStateActive;
    frost.wantsLayer = true;
    frost.layer.cornerRadius = 16;
    frost.layer.masksToBounds = true;
    frost.addSubview(content);
    panel.contentView = frost;
  }

  // AppKit's y axis runs up from the bottom edge.
  const top = H - PAD;
  const icon = $.NSImageView.alloc.initWithFrame($.NSMakeRect(PAD, top - ICON, ICON, ICON));
  icon.image = $.NSImage.alloc.initWithContentsOfFile(iconPath);
  icon.imageScaling = $.NSImageScaleProportionallyUpOrDown;
  icon.wantsLayer = true;
  icon.layer.cornerRadius = 12;
  icon.layer.masksToBounds = true;
  content.addSubview(icon);

  const textTop = top - Math.max(0, (topH - textH) / 2);
  let y = textTop;
  for (const [part, gap] of [[eyebrow, 0], [title, 2], [body, 4]]) {
    y -= gap + part.height;
    part.field.frame = $.NSMakeRect(TEXT_X, y, TEXT_W, part.height);
  }
  content.addSubview(eyebrow.field);
  content.addSubview(title.field);
  content.addSubview(body.field);

  const buttonW = (TEXT_W - 8) / 2;
  const button = (text, action, x) => {
    const b = $.NSButton.buttonWithTitleTargetAction(text, target, action);
    b.frame = $.NSMakeRect(x, PAD, buttonW, BUTTON_H);
    b.controlSize = $.NSControlSizeLarge;
    content.addSubview(b);
    return b;
  };
  const deny = button("Don't Allow", 'deny:', TEXT_X);
  deny.keyEquivalent = '\u001b';
  const allow = button('Allow', 'allow:', TEXT_X + buttonW + 8);
  // macOS 26 fills a button with the accent color at primary prominence.
  if (allow.respondsToSelector('setTintProminence:')) allow.tintProminence = 3;
  else allow.bezelColor = $.NSColor.controlAccentColor;

  panel.center;
  app.activateIgnoringOtherApps(true);
  const timer = $.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(Number(seconds), target, 'giveUp:', null, false);
  $.NSRunLoop.currentRunLoop.addTimerForMode(timer, $.NSModalPanelRunLoopMode);
  app.runModalForWindow(panel);
  timer.invalidate;
  panel.orderOut(null);
  return answer;
}

// Read-only AX identity, retained inside the existing lazy target helper. Never requests trust.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
const windowEpoch = ObjC.unwrap($.NSUUID.UUID.UUIDString);
const windowReferences = [];
const chromeReferences = [];
const chromeReferenceBuckets = new Map();
// References belong to this helper epoch, never to an engine element number. Only browser chrome metadata is read.
function tabCertificate(app, window, readAttr, scalar) {
  const started = Date.now();
  let check = 'window', details = {};
  const budget = () => { if (Date.now() - started >= 250 || Date.now() < started) throw new Error('chrome-deadline'); };
  // A single in-flight AX query can use its existing 100 ms messaging timeout after this check.
  const attr = (...args) => { budget(); const value = readAttr(...args); budget(); return value; };
  const bucket = (map, element) => {
    budget();
    const hash = Number($.CFHash(element));
    if (!Number.isFinite(hash)) throw new Error('chrome-hash-unknown');
    if (!map.has(hash)) map.set(hash, []);
    return map.get(hash);
  };
  const equal = (a, b) => { budget(); return $.CFEqual(a, b); };
  try {
    const ref = element => {
      const entries = bucket(chromeReferenceBuckets, element);
      const found = entries.find(entry => equal(entry.element, element));
      if (found) return found.ref;
      if (chromeReferences.length >= 4096) throw new Error('chrome-reference-capacity');
      const id = chromeReferences.push(element);
      entries.push({ element, ref: id });
      return id;
    };
    const children = (element, leaf = false) => {
      const value = attr(element, 'AXChildren', leaf);
      if (leaf && value === null) return [];
      const n = Number(value?.count);
      if (!Number.isSafeInteger(n) || n < 0 || n > 256) throw new Error('incomplete-children');
      return Array.from({ length: n }, (_, i) => value.objectAtIndex(i));
    };
    const groups = [], fields = [], seen = new Map();
    let visited = 0;
    const menuState = element => {
      const selected = attr(element, 'AXSelectedChildren', true);
      if ([true, 1].includes(scalar(attr(element, 'AXVisible', true))) || Number(selected?.count ?? 0) > 0) throw new Error('chrome-transient');
    };
    const walk = (element, toolbar = false, depth = 0, ancestors = []) => {
      budget();
      const entries = bucket(seen, element);
      if (depth > 32 || visited >= 1024 || entries.some(other => equal(other, element))) throw new Error('incomplete-chrome');
      entries.push(element); visited++;
      const role = scalar(attr(element, 'AXRole'));
      const description = scalar(attr(element, 'AXRoleDescription', true));
      // Stop at content roots before inspecting attributes, values or children within them.
      if (['AXWebArea', 'AXTextArea'].includes(role) || /html content/i.test(String(description ?? ''))) {
        for (const group of ancestors) group.content = true;
        return;
      }
      if (['AXSheet', 'AXDialog', 'AXAlert', 'AXPopover'].includes(role) ||
          [true, 1].includes(scalar(attr(element, 'AXModal', true))) ||
          role === 'AXMenuBarItem' && [true, 1].includes(scalar(attr(element, 'AXSelected', true)))) throw new Error('chrome-transient');
      // Closed menu children exist even while the menu bar and popup controls are idle.
      // Inspect only their open-state metadata. Never enumerate a menu's descendants.
      if (role === 'AXMenu') { menuState(element); return; }
      if (['AXMenuBarItem', 'AXPopUpButton', 'AXMenuButton'].includes(role)) {
        if ([true, 1].includes(scalar(attr(element, 'AXExpanded', true)))) throw new Error('chrome-transient');
        for (const child of children(element, true)) {
          if (scalar(attr(child, 'AXRole')) === 'AXMenu') menuState(child);
          else throw new Error('unknown-menu-child');
        }
        return;
      }
      toolbar ||= role === 'AXToolbar';
      if (role === 'AXTabGroup') {
        const group = { element, content: false };
        groups.push(group); ancestors = [...ancestors, group];
      }
      if (['AXTextField', 'AXComboBox', 'AXSearchField'].includes(role)) {
        let identifier = scalar(attr(element, 'AXIdentifier', true)), identifierSource = 'AXIdentifier';
        // Gecko exposes chrome DOM ids through AXDOMIdentifier. This is still an explicit
        // address id outside document content, with the same ancestry and retained-reference proof.
        if (identifier === null || identifier === '') {
          identifier = scalar(attr(element, 'AXDOMIdentifier', true)); identifierSource = 'AXDOMIdentifier';
        }
        const settable = Ref();
        budget();
        if (Number($.AXUIElementIsAttributeSettable(element, $('AXValue'), settable)) !== 0) throw new Error('editable-unknown');
        fields.push({ element, role, identifierSource, toolbar, editable: Number(settable[0]) === 1,
          enabled: [true, 1].includes(scalar(attr(element, 'AXEnabled'))),
          secure: scalar(attr(element, 'AXSubrole', true)) === 'AXSecureTextField',
          // An explicit chrome identifier is required. Unknown or localized identifiers take the full read.
          address: typeof identifier === 'string' && /(?:^|[-_ ])(?:urlbar|address|location)(?:[-_ ]|$)/i.test(identifier) });
      }
      const leaf = ['AXButton', 'AXRadioButton', 'AXTab', 'AXTextField', 'AXComboBox', 'AXSearchField', 'AXStaticText', 'AXImage', 'AXMenuBarItem'].includes(role);
      for (const child of children(element, leaf)) walk(child, toolbar, depth + 1, ancestors);
    };
    if (scalar(attr(window, 'AXSubrole')) !== 'AXStandardWindow') throw new Error('nonstandard-window');
    check = 'walk';
    walk(window);
    // A tracking menu can live outside AXWindows. A missing menu bar is unknown, not an empty menu.
    walk(attr(app, 'AXMenuBar'));
    check = 'tab-group';
    const strips = [];
    details.groups = groups.length;
    for (const group of groups) {
      const direct = children(group.element);
      const tabChildren = direct.filter(child => ['AXRadioButton', 'AXTab'].includes(scalar(attr(child, 'AXRole'))));
      // Safari's content container is also AXTabGroup. Exclude it only with positive
      // content-root evidence and no direct tabs. An empty or unknown group still refuses.
      if (!tabChildren.length && group.content) continue;
      strips.push({ group: group.element, direct, tabChildren });
    }
    details.strips = strips.length;
    if (!strips.length) throw new Error('missing-tab-strip');
    if (strips.length !== 1) throw new Error('ambiguous-tab-group');
    const { group, direct, tabChildren } = strips[0], tabs = [];
    check = 'tab-selection';
    for (const child of tabChildren) {
      const selected = scalar(attr(child, 'AXValue'));
      if (![true, false, 0, 1].includes(selected)) throw new Error('unknown-tab-selection');
      tabs.push({ ref: ref(child), selected: selected === true || selected === 1 });
    }
    details.tabs = tabs.length; details.selected = tabs.filter(tab => tab.selected).length;
    if (!tabs.length || tabs.filter(tab => tab.selected).length !== 1) throw new Error('ambiguous-selected-tab');
    check = 'address-field';
    details.fieldCount = fields.length;
    details.fields = fields.slice(0, 8).map(({ element, ...metadata }) => metadata);
    if (fields.length !== 1 || !fields[0].toolbar || !fields[0].editable || !fields[0].enabled ||
        fields[0].secure || !fields[0].address) throw new Error('unproved-address-field');
    const field = fields[0].element;
    check = 'address-ancestry';
    let owner = field, reached = false;
    const parents = [];
    for (let depth = 0; owner && depth < 40; depth++) {
      budget();
      if (equal(owner, window)) { reached = true; break; }
      if (parents.some(other => equal(other, owner))) break;
      parents.push(owner); owner = attr(owner, 'AXParent', true);
    }
    if (!reached) throw new Error('address-ancestry-unknown');
    check = 'focus';
    const focused = attr(app, 'AXFocusedUIElement');
    const certificate = { complete: true, group: ref(group), childCount: direct.length, children: direct.map(ref), tabCount: tabs.length, tabs,
      addressField: ref(field), focused: equal(field, focused) ? ref(field) : null };
    budget();
    return { ...certificate, walkMs: Date.now() - started };
  } catch (error) { return { complete: false, reason: String(error.message ?? error), check, details, walkMs: Date.now() - started }; }
}
// JXA's Ref('CGPoint') reads back as the number 0, so this fallback never matched (macOS 27.0.1, 2026-10-16).
// Copy the struct into bytes and read it back through NSValue.
function axPair(value, type) {
  const bytes = $.NSMutableData.dataWithLength(16);
  if (!$.AXValueGetValue(value, type, bytes.mutableBytes)) return null;
  const boxed = $.NSValue.valueWithBytesObjCType(bytes.bytes, type === 1 ? '{CGPoint=dd}' : '{CGSize=dd}');
  const s = ObjC.deepUnwrap(type === 1 ? boxed.pointValue : boxed.sizeValue);
  return type === 1 ? [s.x, s.y] : [s.width, s.height];
}
function run(argv) {
  let closeCount = false, unknownReason = 'helper-error';
  try {
    if (!$.AXIsProcessTrusted()) return JSON.stringify({ status: 'denied' });
    const request = JSON.parse(argv[0]);
    // DP1 asks only for metadata on the already approved leased process. Never
    // resolve a different instance by bundle, or read title/document attributes.
    if (request.closeCount) {
      closeCount = true; unknownReason = 'lease-invalid';
      const { pid, processStart } = request.nativeIdentity ?? {};
      if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(processStart)) throw new Error('Missing leased process');
      const current = () => {
        unknownReason = 'process-changed';
        const running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
        if (!running || running.isNil()) return { status: 'ok', appId: request.appId, pid, processStart, running: false };
        const actual = { appId: ObjC.unwrap(running.bundleIdentifier), pid: Number(running.processIdentifier),
          processStart: Number(running.launchDate.timeIntervalSince1970), running: running.terminated === false };
        // Preserve concrete conflicts even on a terminated replacement. Absence
        // of the leased pid is distinct from reusing it for another launch.
        if (actual.pid !== pid || actual.appId !== request.appId || actual.processStart !== processStart) {
          return { status: 'unknown', unknownReason, ...actual };
        }
        if (running.terminated === true) return { status: 'ok', ...actual };
        if (running.terminated !== false) throw new Error('Unknown process state');
      };
      const before = current();
      if (before) return JSON.stringify(before);
      unknownReason = 'ax-error';
      const app = $.AXUIElementCreateApplication(pid), deadline = Date.now() + 150;
      const expired = () => {
        if (Date.now() >= deadline) { unknownReason = 'deadline'; throw new Error('Metadata deadline'); }
      };
      if (Number($.AXUIElementSetMessagingTimeout(app, 0.05)) !== 0) throw new Error('AX deadline unavailable');
      const attr = (element, name, optional = false) => {
        expired(); unknownReason = 'ax-error';
        const value = Ref(), error = Number($.AXUIElementCopyAttributeValue(element, $(name), value));
        if (optional && [-25205, -25212].includes(error)) return null;
        if (error) throw new Error('AX metadata unavailable');
        return ObjC.castRefToObject(value[0]);
      };
      const count = list => {
        unknownReason = 'ax-invalid';
        if (list === null || list === undefined) throw new Error('Missing AX list');
        const n = Number(list.count);
        if (!Number.isSafeInteger(n) || n < 0 || n > 64) throw new Error('AX list bound');
        return n;
      };
      const windows = attr(app, 'AXWindows');
      let windowCount = count(windows);
      // A positive count just after Cmd+W may still contain the closing window.
      // Only the retained AX reference can distinguish it from a remaining one.
      const baseline = request.nativeIdentity.epoch === windowEpoch
        ? windowReferences[request.nativeIdentity.window - 1] : undefined;
      let closedWindowPresent;
      if (baseline) {
        closedWindowPresent = false;
        for (let i = 0; i < windowCount; i++) {
          expired();
          if ($.CFEqual(baseline, windows.objectAtIndex(i))) closedWindowPresent = true;
        }
      }
      let modalCount = 0, seen = 0;
      const visit = (children, depth, descend = true) => {
        const n = count(children);
        if (depth > 8 || seen + n > 64) throw new Error('AX child bound');
        seen += n;
        for (let i = 0; i < n; i++) {
          const child = children.objectAtIndex(i), role = ObjC.deepUnwrap(attr(child, 'AXRole'));
          if (typeof role !== 'string') throw new Error('Missing AX role');
          const subrole = ObjC.deepUnwrap(attr(child, 'AXSubrole', true));
          if (role === 'AXSheet' || role === 'AXDialog' || subrole === 'AXDialog' || subrole === 'AXSystemDialog' ||
              ObjC.deepUnwrap(attr(child, 'AXModal', true)) === true) { modalCount++; continue; }
          if (role === 'AXWindow') throw new Error('Window missing from AXWindows');
          // Menu contents are separate from the app's window and modal children.
          if (role === 'AXMenuBar' || role === 'AXMenu') continue;
          const nested = descend ? attr(child, 'AXChildren', true) : null;
          if (nested !== null) visit(nested, depth + 1);
        }
      };
      if (closedWindowPresent === true) {
        // A sheet on a different window cannot confirm this Close. Inspect only
        // its direct children, without walking the document's controls.
        const children = attr(baseline, 'AXChildren', true);
        if (children !== null) visit(children, 0, false);
      }
      if (windowCount === 0) {
        visit(attr(app, 'AXChildren'), 0);
        // AXWindows can omit windows on other Spaces. Filter the leased PID's
        // document, panel and alert layers inside Foundation, without copying content.
        expired(); unknownReason = 'cg-error';
        const cg = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(
          $.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements, 0));
        unknownReason = 'cg-invalid';
        if (!cg || cg.isNil?.()) throw new Error('Missing CG list');
        const total = Number(cg.count);
        if (!Number.isSafeInteger(total) || total < 0 || total > 10000) throw new Error('CG list bound');
        // Missing owners do not match. An owned row with a missing layer stays
        // in the candidates so it makes the proof unknown instead of disappearing.
        unknownReason = 'predicate-error';
        const own = cg.filteredArrayUsingPredicate($.NSPredicate.predicateWithFormatArgumentArray(
          'kCGWindowOwnerPID == %@ AND (kCGWindowLayer == nil OR (kCGWindowLayer >= 0 AND kCGWindowLayer <= 23))', [pid]));
        unknownReason = 'cg-invalid';
        const n = Number(own.count), ids = [];
        if (!Number.isSafeInteger(n) || n < 0 || n > total) throw new Error('CG candidate bound');
        for (let i = 0; i < n; i++) {
          expired();
          const row = own.objectAtIndex(i);
          const layer = ObjC.unwrap(row.objectForKey('kCGWindowLayer'));
          if (!Number.isSafeInteger(layer) || layer < 0 || layer > 23) throw new Error('Missing CG layer');
          ids.push(ObjC.unwrap(row.objectForKey('kCGWindowNumber')));
        }
        // Reuse SW1b's Space membership check from the enclosing app-health
        // helper. Ordered-out CG rows with no Space do not count as windows.
        unknownReason = 'cgs-unbound';
        const held = spaceWindows(ids, deadline, reason => { unknownReason = reason; });
        if (!Number.isSafeInteger(held) || held < 0) throw new Error('Unknown Space membership');
        windowCount = held;
        // AX omitted these other-Space windows, so it cannot say whether one
        // of them is the closing target. Keep positive-count reads blocked.
        if (held > 0) closedWindowPresent = undefined;
      }
      const after = current();
      if (after) return JSON.stringify(after);
      expired();
      return JSON.stringify({ status: 'ok', appId: request.appId, pid, processStart, running: true, windowCount, modalCount,
        ...(closedWindowPresent !== undefined ? { closedWindowPresent } : {}) });
    }
    const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(request.appId);
    if (Number(apps.count) !== 1) throw new Error('Expected one running app');
    const running = apps.objectAtIndex(0), pid = Number(running.processIdentifier);
    if (request.followTab && (!request.tabCertificate || request.nativeIdentity?.epoch !== windowEpoch ||
        request.nativeIdentity?.pid !== pid || request.nativeIdentity?.processStart !== Number(running.launchDate.timeIntervalSince1970) ||
        !windowReferences[request.nativeIdentity?.window - 1])) throw new Error('Tab window baseline unavailable');
    const app = $.AXUIElementCreateApplication(pid);
    if (Number($.AXUIElementSetMessagingTimeout(app, 0.1)) !== 0) throw new Error('AX deadline unavailable');
    const attr = (element, name, optional = false) => {
      const value = Ref(), error = Number($.AXUIElementCopyAttributeValue(element, $(name), value));
      if (optional && [-25205, -25212].includes(error)) return null;
      if (error) throw new Error(name + ' unavailable');
      return ObjC.castRefToObject(value[0]);
    };
    const scalar = value => value === null ? null : ObjC.deepUnwrap(value);
    const hidIdleSeconds = () => {
      try { return Number($.CGEventSourceSecondsSinceLastEventType(1, 0xFFFFFFFF)); } catch { return null; }
    };
    const windows = attr(app, 'AXWindows');
    let matches = [];
    if (Number(windows.count) > 64) throw new Error('Too many windows');
    for (let i = 0; i < Number(windows.count); i++) {
      const window = windows.objectAtIndex(i);
      // Finder's desktop window has no AXTitle (-25212), and requiring one failed every Finder identity
      // (late-alert probe, 2026-10-17: 5 of 5 baselines empty). A window without a title matches no header.
      const title = scalar(attr(window, 'AXTitle', true));
      if (request.followTab ? $.CFEqual(window, windowReferences[request.nativeIdentity.window - 1])
        : title !== null && title === request.title && scalar(attr(window, 'AXDocument', true)) === request.url) matches.push(window);
    }
    // Before the number or focus narrows them: a caller with no number for the window needs exactly one.
    let headerMatches = matches.length;
    const focused = attr(app, 'AXFocusedWindow');
    let cg;
    const number = window => {
      const direct = scalar(attr(window, 'AXWindowNumber', true));
      if (Number.isSafeInteger(direct) && direct > 0) return direct;
      try {
        if (!cg) {
          const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements, 0));
          cg = Array.from({ length: Number(list.count) }, (_, i) => ObjC.deepUnwrap(list.objectAtIndex(i)));
        }
        const position = axPair(attr(window, 'AXPosition'), 1), size = axPair(attr(window, 'AXSize'), 2);
        if (!position || !size) return null;
        const bounds = [...position, ...size];
        if (!bounds.every(Number.isFinite)) return null;
        const matches = cg.filter(info => Number(info.kCGWindowOwnerPID) === pid && info.kCGWindowLayer === 0 &&
          ['X', 'Y', 'Width', 'Height'].every((key, i) => Math.abs(info.kCGWindowBounds?.[key] - bounds[i]) < 0.5));
        return matches.length === 1 ? matches[0].kCGWindowNumber : null;
      } catch { return null; }
    };
    const requestedNumber = request.windowNumber ?? request.nativeIdentity?.windowNumber;
    if (requestedNumber !== undefined && requestedNumber !== null) {
      const numbers = matches.map(number);
      matches = matches.filter((window, i) => numbers[i] === requestedNumber);
      if (!matches.length && numbers.length && numbers.every(value => Number.isSafeInteger(value) && value > 0)) {
        return JSON.stringify({ status: 'mismatch', error: 'Known window number disappeared' });
      }
    }
    else if (matches.length > 1 && !request.allowUnfocused) {
      const focusedNumber = number(focused);
      if (Number.isSafeInteger(focusedNumber) && focusedNumber > 0) matches = matches.filter(window => number(window) === focusedNumber);
    }
    if (matches.length !== 1) return JSON.stringify({ status: 'ok', matches: matches.length, headerMatches,
      appId: request.appId, title: request.title, url: request.url, epoch: windowEpoch, window: 0,
      pid, processStart: Number(running.launchDate.timeIntervalSince1970), hidIdleSeconds: hidIdleSeconds() });
    const window = matches[0];
    if (request.followTab) {
      request.title = scalar(attr(window, 'AXTitle'));
      request.url = scalar(attr(window, 'AXDocument', true));
      headerMatches = 0;
      for (let i = 0; i < Number(windows.count); i++) {
        const candidate = windows.objectAtIndex(i);
        if (scalar(attr(candidate, 'AXTitle', true)) === request.title && scalar(attr(candidate, 'AXDocument', true)) === request.url) headerMatches++;
      }
    }
    // Only read-only discovery may read an unfocused window. Input admission still requires focus.
    // A unique header must also describe the app's focused window. Otherwise the engine's handle
    // and Accessibility disagree about which window a background input would reach.
    if (!request.allowUnfocused && !$.CFEqual(window, focused)) return JSON.stringify({ status: 'mismatch', error: 'Focused window differs' });
    let index = windowReferences.findIndex(other => $.CFEqual(other, window));
    if (index < 0) {
      if (windowReferences.length >= 1024) throw new Error('Window identity capacity reached');
      index = windowReferences.push(window) - 1;
    }
    // The guard's light check after Return (SLEIGHT_GUARD_LIGHT_RETURN): sheets on this window, and the
    // focused element's role and subrole (AXSecureTextField refuses it) and whether it sits in this
    // window, by AXWindow or else its parents.
    let focus;
    if (request.focus) {
      const children = attr(window, 'AXChildren', true);
      let sheets = 0;
      for (let i = 0; i < Math.min(Number(children?.count ?? 0), 256); i++) {
        if (scalar(attr(children.objectAtIndex(i), 'AXRole', true)) === 'AXSheet') sheets++;
      }
      const element = attr(app, 'AXFocusedUIElement', true);
      let inWindow = false;
      if (element) {
        const owner = attr(element, 'AXWindow', true);
        if (owner) inWindow = !!$.CFEqual(owner, window);
        else for (let node = element, depth = 0; node && depth < 40 && !inWindow; depth++) {
          inWindow = !!$.CFEqual(node, window);
          node = attr(node, 'AXParent', true);
        }
      }
      // A web area above the focused element (Gecko names it HTML content) puts it in a page, where a tab continuation's
      // typing must not land. Walks up to the window, like the search above.
      let inPage = false;
      for (let node = element, depth = 0; node && depth < 40 && !inPage && !$.CFEqual(node, window); depth++) {
        const role = scalar(attr(node, 'AXRole', true)), description = scalar(attr(node, 'AXRoleDescription', true));
        inPage = role === 'AXWebArea' || /html content/i.test(String(role ?? '')) || /html content/i.test(String(description ?? ''));
        node = attr(node, 'AXParent', true);
      }
      focus = { sheets, role: element ? scalar(attr(element, 'AXRole', true)) : null,
        subrole: element ? scalar(attr(element, 'AXSubrole', true)) ?? null : null, inWindow, inPage };
    }
    const chrome = request.tabCertificate ? tabCertificate(app, window, attr, scalar) : undefined;
    if (request.tabCertificate && !$.CFEqual(window, attr(app, 'AXFocusedWindow'))) throw new Error('Window changed during certificate');
    return JSON.stringify({ status: 'ok', matches: 1, headerMatches, appId: request.appId, title: request.title, ...(chrome ? { chrome } : {}),
      url: request.url, epoch: windowEpoch, window: index + 1, windowNumber: number(window), pid,
      // The parent lease takes only a standard window (SLEIGHT_PARENT_LEASE), read before HID idle is sampled.
      windowSubrole: scalar(attr(window, 'AXSubrole', true)) ?? null,
      processStart: Number(running.launchDate.timeIntervalSince1970), hidIdleSeconds: hidIdleSeconds(), ...(focus ? { focus } : {}) });
  } catch (error) { return JSON.stringify(closeCount ? { status: 'unknown', unknownReason }
    : { status: 'unknown', error: String(error.message || error) }); }
}

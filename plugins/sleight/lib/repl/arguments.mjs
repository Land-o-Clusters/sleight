// Mac facade normalization only. The parent and driver still admit every action.
export const MAC_API_ALIASES = Object.freeze({ read: 'getAXState', screenshot: 'getScreenshot',
  type: 'typeText', key: 'pressKey', press: 'pressKey' });
export const MAC_API_FIXES = Object.freeze({
  target: 'Use a current element number, {id:"exact ID"}, {label:"exact label"}, or [x,y].',
  click: 'Use app.click(target, {mouseButton:"left", clickCount:1}); buttons: left/right/middle; count: 1..3.',
  doubleClick: 'Use app.doubleClick(target) with no options.',
  rightClick: 'Use app.rightClick(target) with no options.',
  setValue: 'Use app.setValue(element, value), where value is text, a boolean or a finite number.',
  typeText: 'Use app.typeText(text) with no target; click the field first if needed.',
  pressKey: 'Use app.pressKey("super+s") with no target; click the field first if needed.',
  scroll: 'Use app.scroll(target, "down", pages) or {pixels:n}; directions: up/down/left/right; positive distance.',
  typeTextLength: 'Split text into calls of at most 16384 characters, then use app.typeText(text).',
  scrollDistance: 'Scroll by at most 100 pages or 100000 pixels per call, with a positive distance.',
  read: 'Use app.getAXState(options) on a named app handle.',
  screenshot: 'Use app.getScreenshot(options) on a named app handle.',
  type: 'Use app.typeText(text) on a named app handle.',
  key: 'Use app.pressKey(chord) on a named app handle.',
  press: 'Use app.pressKey(chord) on a named app handle.',
  drag: 'Use app.drag(from, to) with two current targets.',
  selectText: 'Use app.selectText(element, text, {prefix:"", suffix:"", selectionType:"text"}).',
  performSecondaryAction: 'Use app.performSecondaryAction(element, "advertised action").',
  paste: 'Use app.paste(text, {format:"text"}) with no target; formats: text/md/html.',
  getAXState: 'Use app.getAXState({emit:true, depth:64, budgetMs:1000}); depth: 0..64; budgetMs: 1..30000.',
  getScreenshot: 'Use app.getScreenshot({format:"png", scale:"pixel"}); formats: png/jpeg; scales: pixel/point.',
  getApp: 'Use cua.getApp("app name or bundle ID") or cua.getApp({windowId:"123"}).',
  listWindows: 'Use cua.getState() for apps and windows; listWindows is unavailable.',
  method: 'Use the documented app methods; await cua.rewriteDocumentation() for the reference.',
  javascript: 'Check bindings and missing find() results before using them; read the current tree.',
});
export function apiMisuse(kind = 'method') {
  return Object.assign(Error('sleight: ' + (MAC_API_FIXES[kind] ?? MAC_API_FIXES.method) + ' Operation not sent.'),
    { code: 'SLEIGHT_API_MISUSE', delivery: 'not-sent', retry: 'safe' });
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const text = value => typeof value === 'string' && value.length <= 1_048_576;
const element = value => Number.isSafeInteger(value) && value >= 0 || object(value) && Object.keys(value).length === 1 &&
  ['id', 'label'].some(key => text(value[key]) && value[key].length > 0 && value[key].length <= 16384);
export function validateMacAcquisition(args) {
  const [selector, options] = args;
  if (![1, 2].includes(args.length) || !(typeof selector === 'string' && selector.trim() ||
      fields(selector, ['windowId']) && Object.keys(selector).length === 1 &&
      typeof selector.windowId === 'string' && /^[1-9]\d*$/.test(selector.windowId)) ||
      options !== undefined && (!fields(options, ['emit', 'launch']) ||
        ['emit', 'launch'].some(key => Object.hasOwn(options, key) && typeof options[key] !== 'boolean')))
    throw apiMisuse('getApp');
}
export function validateMacRead(method, args) {
  const fail = () => { throw apiMisuse(method === 'getAXStateAndScreenshot' ? 'getScreenshot' : method); };
  if (args.length > 1) return fail();
  if (!args.length || args[0] === undefined) return;
  const options = args[0];
  const keys = ['emit', ...method !== 'getScreenshot' ? ['disableDiffing', 'depth', 'budgetMs'] : [],
    ...method !== 'getAXState' ? ['format', 'scale'] : []];
  if (!fields(options, keys)) return fail();
  if (['emit', 'disableDiffing'].some(key => Object.hasOwn(options, key) && typeof options[key] !== 'boolean')) return fail();
  if (options.depth !== undefined && (!Number.isInteger(options.depth) || options.depth < 0 || options.depth > 64) ||
      options.budgetMs !== undefined && (!Number.isInteger(options.budgetMs) || options.budgetMs < 1 || options.budgetMs > 30000)) return fail();
  if (options.format !== undefined && !['png', 'jpeg'].includes(options.format) ||
      options.scale !== undefined && !['pixel', 'point'].includes(options.scale)) return fail();
}
export function macTarget(value, point = true, focused = false) {
  if (point && fields(value, ['x', 'y']) && Object.keys(value).length === 2) value = [value.x, value.y];
  if (focused && fields(value, ['focused']) && value.focused === true) return { focused: true };
  if (typeof value === 'string' && value.length > 0 && value.length <= 16384) return value;
  if (element(value) || point && Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)) return value;
  throw apiMisuse('target');
}
export function normalizeMacAction(name, input) {
  name = MAC_API_ALIASES[name] ?? name;
  const args = [...input], [a, b, c] = args;
  const fail = () => { throw apiMisuse(name); };
  switch (name) {
    case 'click': {
      if (![1, 2].includes(args.length)) return fail();
      args[0] = macTarget(a, true, true);
      if (args.length === 2) {
        if (!fields(b, ['mouseButton', 'button', 'clickCount'])) return fail();
        const options = { ...b };
        if (Object.hasOwn(options, 'button')) {
          if (Object.hasOwn(options, 'mouseButton') && options.button !== options.mouseButton) return fail();
          options.mouseButton = options.button; delete options.button;
        }
        const buttons = { l: 'left', r: 'right', m: 'middle' };
        if (Object.hasOwn(options, 'mouseButton')) {
          options.mouseButton = Object.hasOwn(buttons, options.mouseButton) ? buttons[options.mouseButton] : options.mouseButton;
          if (!['left', 'right', 'middle'].includes(options.mouseButton)) return fail();
        }
        if (Object.hasOwn(options, 'clickCount') && ![1, 2, 3].includes(options.clickCount)) return fail();
        args[1] = options;
      }
      break;
    }
    case 'doubleClick': case 'rightClick':
      if (args.length !== 1) return fail();
      args[0] = macTarget(a); break;
    case 'drag':
      if (args.length !== 2) return fail();
      args[0] = macTarget(a); args[1] = macTarget(b); break;
    case 'scroll':
      if (typeof c === 'number' && c > 100 || object(c) && typeof c.pixels === 'number' && c.pixels > 100000)
        throw apiMisuse('scrollDistance');
      if (args.length !== 3 || !['up', 'down', 'left', 'right'].includes(b) ||
          !(typeof c === 'number' && Number.isFinite(c) && c > 0 && c <= 100 ||
            fields(c, ['pixels']) && Object.keys(c).length === 1 && typeof c.pixels === 'number' &&
            Number.isFinite(c.pixels) && c.pixels > 0 && c.pixels <= 100000)) return fail();
      args[0] = macTarget(a); break;
    case 'setValue':
      if (args.length !== 2 || !(text(b) || typeof b === 'boolean' || typeof b === 'number' && Number.isFinite(b))) return fail();
      args[0] = macTarget(a, false, true); break;
    case 'selectText':
      if (![2, 3].includes(args.length) || !text(b) || !b.length || args.length === 3 &&
          (!fields(c, ['prefix', 'suffix', 'selectionType']) ||
           ['prefix', 'suffix'].some(key => Object.hasOwn(c, key) && !text(c[key])) ||
           Object.hasOwn(c, 'selectionType') && !['text', 'cursor_before', 'cursor_after'].includes(c.selectionType))) return fail();
      args[0] = macTarget(a, false, true); break;
    case 'performSecondaryAction':
      if (args.length !== 2 || !text(b) || !b.length) return fail();
      args[0] = macTarget(a, false); break;
    case 'paste':
      if (![1, 2].includes(args.length) || !text(a) || args.length === 2 &&
          (!fields(b, ['format']) || Object.hasOwn(b, 'format') && !['text', 'md', 'html'].includes(b.format))) return fail();
      break;
    case 'typeText':
      if (typeof a === 'string' && a.length > 16384) throw apiMisuse('typeTextLength');
      if (args.length !== 1 || !text(a) || a.length > 16384 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(a)) return fail();
      break;
    case 'pressKey':
      if (args.length !== 1 || !text(a) || !a.length || a.length > 256 || /\s|[\x00-\x1f\x7f]/u.test(a)) return fail();
      break;
    default: return fail();
  }
  return { method: name, args };
}

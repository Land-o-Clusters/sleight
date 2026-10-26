import { trustedLocatorRead } from './trusted-dom.mjs';
import { isV3Context } from './v3-context.mjs';
import { backgroundClick as guardedClick } from './page.mjs';
import { readOptions, moveList, pickElement, findPopup, searchOptions, describeMiss, normalize, queries } from './pick-option.mjs';
import { lineBreakRefusal } from './rules.mjs';
import { snapshotAcquisitionPending } from './snapshot.mjs';
import { assertPageResponsive } from './page-health.mjs';
import { checkConsent } from './consent-wall.mjs';
// Whole-form strategies are sleight's own (the v2 forms.mjs they came from is gone). Playwright's
// aria-ref selector routes fNeM refs to their child frame, without parent fallback.
class FieldError extends Error {}
// A refusal after only typing or scrolling, which says plainly what happened instead of "field may have changed".
const said = message => Object.assign(new FieldError(message), { said: true });
const actionFailed = result => result?.lines?.some(line => /: not run:|effect unconfirmed;/.test(line));
const refPattern = /^(?:(?:f\d+)?e\d+|[sx]\d+)$/;
const options = { timeout: 1500 };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function order(el) {
  const label = node => {
    const named = node.getAttribute('aria-label');
    if (named) return named.trim();
    const text = n => n.nodeType === 3 ? n.textContent : n.getAttribute?.('aria-hidden') === 'true' ? '' :
      n.childNodes ? [...n.childNodes].map(text).join('') : n.textContent ?? '';
    return text(node).trim();
  };
  return [...el.children].map(label);
}

function inspect(el, expected, read = (node, key) => { const value = node?.[key]; return typeof value === 'function' ? value.bind(node) : value; }) {
  const attr = name => read(el, 'getAttribute')(name), tag = read(el, 'tagName').toLowerCase(), role = attr('role') ?? '';
  const type = tag === 'input' ? read(el, 'type') : '';
  const checked = typeof read(el, 'checked') === 'boolean' ? read(el, 'checked') : ['true', 'false'].includes(attr('aria-checked')) ? attr('aria-checked') === 'true' : null;
  const kind = tag === 'select' ? 'select' : type === 'file' ? 'file' : type === 'color' ? 'color' : type === 'range' || role === 'slider' ? 'range' :
    ['checkbox', 'radio'].includes(type) || ['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role) ? 'check' :
    ['ul', 'ol'].includes(tag) && [...read(el, 'children')].every(n => read(n, 'getAttribute')('draggable') === 'true') ? 'reorder' :
    role === 'listbox' ? 'listbox' : role === 'combobox' || attr('aria-autocomplete') === 'list' ? 'combo' :
    ['input', 'textarea'].includes(tag) || read(el, 'isContentEditable') ? 'text' : 'custom';
  // Form ownership stops at a shadow root, but a control in one still acts for the form around its host. Climb host by host.
  const enclosing = (node, selector) => {
    for (let at = node; at;) {
      const found = read(at, 'closest')(selector);
      if (found) return found;
      const root = read(at, 'getRootNode')?.();
      at = root && read(root, 'nodeType') === 11 ? read(root, 'host') : null;
    }
    return null;
  };
  const text = String(read(el, 'value') ?? read(el, 'textContent') ?? ''), form = enclosing(el, 'form');
  const words = [attr('aria-label'), read(el, 'textContent'), attr('value')].join(' ');
  const payment = /\b(?:pay|payment|purchase|buy|checkout|donate|subscribe|place order|complete order|order now|book now|upgrade|send money|charge)\b/i.test(words);
  const button = tag === 'button' || role === 'button' || ['submit', 'button', 'reset'].includes(type);
  const submit = !!(type === 'submit' || button && form && attr('type') !== 'button' && attr('type') !== 'reset' || button && payment);
  const rect = read(el, 'getBoundingClientRect')?.(), style = read(read(read(el, 'ownerDocument'), 'defaultView'), 'getComputedStyle')?.(el);
  const multiList = kind === 'listbox' && attr('aria-multiselectable') === 'true';
  // This only chooses the guarded action route; that route proves eligibility, attachment and focus again.
  const nativeEditContext = (() => { try {
    if (typeof HTMLElement === 'undefined' || typeof EditContext === 'undefined') return false;
    const context = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'editContext')?.get?.call(el);
    return !!context && Array.isArray(Object.getOwnPropertyDescriptor(EditContext.prototype, 'attachedElements')?.value?.call(context));
  } catch { return false; } })();
  return { kind, type, tag, role, nativeEditContext,
    editableText: !read(el, 'readOnly') && (tag === 'input' || tag === 'textarea' || read(el, 'isContentEditable')), submit, payment, form: !!form, formPayment: payment, enabled: !read(el, 'disabled') && attr('aria-disabled') !== 'true',
    hiddenLabel: ['checkbox', 'radio'].includes(type) && !!read(el, 'labels')?.length && (!!style?.clip && style.clip !== 'auto' || rect && (!rect.width || !rect.height)),
    visible: rect ? rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none' : undefined, checked, connected: read(el, 'isConnected'), readonly: !!read(el, 'readOnly') || multiList && attr('aria-readonly') === 'true', disabled: !!read(el, 'disabled') || attr('aria-disabled') === 'true',
    controls: attr('aria-controls'), expanded: attr('aria-expanded'), multiple: !!read(el, 'multiple') || multiList,
    innerInput: tag !== 'input' && !!read(el, 'querySelector')?.('input:not([type="hidden"]), textarea'), current: text.slice(0, 300),
    matched: text === String(expected),
    min: read(el, 'min') || attr('aria-valuemin') || '0', max: read(el, 'max') || attr('aria-valuemax') || '100', step: read(el, 'step') || '1',
    number: Number(type === 'range' ? read(el, 'value') : attr('aria-valuenow')),
    options: kind === 'select' ? [...read(el, 'options')].map(o => ({ value: read(o, 'value'), label: read(o, 'label'), disabled: read(o, 'disabled') || !!read(read(o, 'parentElement'), 'disabled'), selected: read(o, 'selected') })) :
      multiList ? [...read(el, 'querySelectorAll')('[role="option"]')].slice(0, 1001).map(o => {
        const attr = name => read(o, 'getAttribute')(name), selected = attr('aria-selected');
        return { label: (attr('aria-label') || read(o, 'textContent') || '').trim(),
          selected: selected === 'true' ? true : selected === 'false' ? false : null,
          disabled: !!read(o, 'disabled') || attr('aria-disabled') === 'true', size: attr('aria-setsize'), position: attr('aria-posinset') };
      }) : undefined };
}

function validate(fields, submit) {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 60) throw new FieldError('fields must contain 1 to 60 entries');
  if (submit !== undefined && !refPattern.test(submit)) throw new FieldError('submit needs a snapshot ref');
  if (/^x\d+$/.test(submit)) throw new FieldError('keyboard-only ref cannot submit');
  for (const field of fields) {
    if (!field || typeof field.ref !== 'string' || !refPattern.test(field.ref)) throw new FieldError('each field needs a snapshot ref');
    const value = field.value;
    if (/^x\d+$/.test(field.ref) && !['string', 'number'].includes(typeof value)) throw new FieldError('keyboard-only fields need text or a number');
    if (!(typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ||
      typeof value === 'string' && value.length <= 65536 || Array.isArray(value) && value.length <= 100 &&
      value.every(v => typeof v === 'string' && v.length <= 512))) throw new FieldError('unsupported field value');
  }
}
function refusal(result) {
  if (result === 'allow' || result?.status === 'allow' || result?.kind === 'allow' || result?.verdict === 'allow') return;
  if (result?.status === 'confirm' || result?.kind === 'confirm' || result?.verdict === 'confirm') throw new FieldError('confirmation required' + (process.env.SLEIGHT_MT === '0' ? '; use the engine browser path' : ''));
  const message = typeof result === 'string' ? result : result?.message ?? result?.msg;
  throw new FieldError(message || 'rules refused input' + (process.env.SLEIGHT_MT === '0' ? '; use the engine browser path' : ''));
}

export function createFillFields({ check, runSteps, backgroundClick = guardedClick, inspectElement = inspect, now = Date.now, sleep = pause, hand } = {}) {
  if (typeof check !== 'function' || typeof runSteps !== 'function') throw new FieldError('fill requires rules and actions');
  return async function fillFields(tab, fields, { submit, onAction } = {}, ctx) {
    validate(fields, submit);
    if (!tab?.page || !tab.state) throw new FieldError('fill needs an owned tab');
    const { page } = tab, rows = fields.map(({ ref }) => ({ ref, status: 'not reached' }));
    let stopped, sent = false;
    const handlers = { framenavigated: () => { stopped = 'new document; read the page before continuing'; },
      dialog: () => { stopped = 'dialog is waiting; answer it before continuing'; },
      popup: () => { stopped = 'background popup opened; read the tabs before continuing'; },
      close: () => { stopped = 'tab closed'; } };
    for (const [name, fn] of Object.entries(handlers)) page.on(name, fn);
    let submitted = { status: submit === undefined ? 'not requested' : 'not reached' };
    try {
      for (let i = 0; i < fields.length && !stopped; i++) {
        const { ref, value } = fields[i]; sent = false;
        try {
          assertPageResponsive(tab);
          if (tab.state.actionPending) throw new FieldError('an earlier input is still pending; wait before filling');
          if (snapshotAcquisitionPending(page)) throw new FieldError('Snapshot acquisition is still pending; wait before another action or read.');
          const nativeText = async () => {
            if (!isV3Context(ctx)) throw new FieldError('keyboard-only refs require a trusted context');
            if (!['string', 'number'].includes(typeof value)) throw new FieldError('EditContext fields need text or a number');
            const result = await runSteps(tab, [{ do: 'type', ref, text: String(value) }], ctx, onAction ? { onAction } : undefined);
            sent = !!result?.lines?.length && !result.lines.some(line => /: not run:/.test(line));
            if (!result?.lines?.length || actionFailed(result)) throw new FieldError('EditContext field stopped; read the page');
            rows[i].status = 'set';
          };
          if (/^x\d+$/.test(ref)) { await nativeText(); continue; }
          if (/^s\d+$/.test(ref)) {
            // A closed-root select takes its option as a string too, so ask the pinned node what kind of control it is.
            const kind = typeof value === 'boolean' || Array.isArray(value) || typeof page.getByRef !== 'function' ? undefined :
              (await trustedLocatorRead(page.getByRef(ref), inspect, value).catch(() => ({}))).kind;
            const step = typeof value === 'boolean' ? { do: value ? 'check' : 'uncheck', ref } :
              Array.isArray(value) ? { do: 'select', ref, values: value } :
              kind === 'select' ? { do: 'select', ref, values: [String(value)] } : { do: 'type', ref, text: String(value) };
            const result = await runSteps(tab, [step], ctx, onAction ? { onAction } : undefined);
            sent = !result?.lines?.some(line => /: not run:/.test(line));
            if (actionFailed(result)) throw new FieldError('closed-root field stopped; read the page');
            rows[i].status = 'set'; continue;
          }
          const loc = typeof page.getByRef === 'function' ? page.getByRef(ref) : page.locator('aria-ref=' + ref);
          let state = await trustedLocatorRead(loc, inspect, value);
          if (state.nativeEditContext) { await nativeText(); continue; }
          if (state.kind === 'select' && state.disabled) {
            const until = now() + 1500;
            while (state.disabled && !stopped && now() < until) {
              await sleep(Math.min(25, until - now()));
              state = await trustedLocatorRead(loc, inspect, value);
            }
            if (state.disabled) throw new FieldError('dependent select stayed disabled; read the form');
          }
          if (!state.connected) throw new FieldError('stale ref; read the page');
          if (state.readonly && state.kind !== 'combo') throw new FieldError('readonly picker; use browser_act on its choices');
          const prior = await trustedLocatorRead(loc, inspectElement);
          if (stopped) throw new FieldError(stopped);
          const send = async (action, kind = 'type', locator = loc, modifier) => {
            assertPageResponsive(tab);
            if (stopped) throw new FieldError(stopped);
            if (tab.state.actionPending) throw new FieldError('an earlier input is still pending; wait before filling');
            const element = await trustedLocatorRead(locator, inspectElement);
            if (stopped) throw new FieldError(stopped);
            const target = { ...element, element, prior, tab, page, ref, locator, state: tab.state, do: kind };
            if (tab.state.actionPending) throw new FieldError('an earlier input is still pending; wait before filling');
            const trusted = isV3Context(ctx);
            if (trusted) await ctx.prepareTarget(target);
            if (stopped) { if (trusted) await ctx.releaseTarget(target); throw new FieldError(stopped); }
            if (tab.state.actionPending) { if (trusted) await ctx.releaseTarget(target); throw new FieldError('an earlier input is still pending; wait before filling'); }
            if (kind === 'click' && (target.element.submit || prior.submit)) {
              if (trusted) await ctx.releaseTarget(target);
              if (locator !== loc) throw new FieldError('submit-capable choice needs its own browser_act ref');
              // V4 classifies, consumes consent once, journals the submit and
              // retains pending input through its settle. Never pre-consume here.
              sent = true;
              const result = await runSteps(tab, [{ do: 'click', ref }], ctx, onAction ? { onAction } : undefined);
              if (!Array.isArray(result?.lines)) throw said('guarded submit result unavailable; field may have changed; read before retrying; use the engine browser path if needed');
              sent = !result.lines.some(line => /: not run:/.test(line));
              if (actionFailed(result)) throw new FieldError('submit stopped; read the page before retrying');
              return result;
            }
            const pending = {};
            try {
              const perform = async (extra = {}, verifySeal) => {
                assertPageResponsive(tab);
                if (stopped) throw new FieldError(stopped);
                if (tab.state.actionPending) throw new FieldError('an earlier input is still pending; wait before filling');
                target.verifySeal = verifySeal;
                // Private page inspection may await, so repeat both fences after
                // it. Newly submit-capable choices refuse without consuming consent.
                refusal(trusted ? await ctx.check(kind, target, { fieldOnly: true }) : check(ctx, kind, target));
                try { await checkConsent(trusted ? target.locator : locator, 'fill', tab.state); }
                catch (error) { throw new FieldError(error.message); }
                assertPageResponsive(tab);
                if (stopped) throw new FieldError(stopped);
                if (tab.state.actionPending) throw new FieldError('an earlier input is still pending; wait before filling');
                tab.state.actionPending = pending;
                if (trusted && modifier) ctx.beginInput(target);
                let cursorToken;
                try { cursorToken = hand?.step({ op: kind, page, locator: trusted ? target.locator : locator, role: element.role, inputType: element.inputType }); } catch {}
                try {
                  sent = true; const result = await action(trusted ? target.locator : locator, target, extra);
                  try { hand?.finish?.(cursorToken, false); } catch {}
                  return result;
                } catch (error) { try { hand?.finish?.(cursorToken, true); } catch {} throw error; }
              };
              return modifier ? await backgroundClick(tab, trusted ? target.locator : locator, perform, { modifier }) : await perform();
            } finally {
              if (tab.state.actionPending === pending) tab.state.actionPending = false;
              try { if (sent && onAction) await onAction(tab, { handle: target.locator }); } catch {}
              finally { if (trusted) await ctx.releaseTarget(target); }
            }
          };
          if (state.kind === 'file') {
            if (!Array.isArray(value) || !value.length) throw new FieldError('file fields need browser_act upload with user-named paths');
            const result = await runSteps(tab, [{ do: 'upload', ref, paths: value }], ctx, onAction ? { onAction } : undefined);
            sent = !result?.lines?.some(line => /: not run:/.test(line));
            if (actionFailed(result)) throw new FieldError('upload stopped; read the page');
          } else if (state.kind === 'check' || state.kind === 'custom' && typeof value === 'boolean' && state.checked !== null) {
            if (typeof value !== 'boolean' || state.checked === null) throw new FieldError('checkable fields need boolean values and a known checked state');
            if (state.checked !== value) {
              if (state.type === 'radio' && value === false) throw new FieldError('choose another radio instead of unchecking this one');
              if (state.hiddenLabel) {
                const handle = await loc.evaluateHandle(el => el.labels[0], undefined, options);
                try {
                  const label = handle.asElement();
                  if (!label) throw new FieldError('associated label unavailable; read the form');
                  await send(checked => checked.click(options), 'click', label);
                } finally { await handle.dispose(); }
              } else await send(checked => state.kind === 'custom' || state.type === '' ? checked.click(options) : checked.setChecked(value, options),
                state.kind === 'custom' || state.type === '' ? 'click' : value ? 'check' : 'uncheck');
            }
            if (!stopped && (await trustedLocatorRead(loc, inspect, value)).checked !== value) throw new FieldError('checked state did not match; read the page');
          } else if (state.kind === 'select') {
            const wanted = Array.isArray(value) ? value : [value];
            if (!wanted.every(v => typeof v === 'string') || !state.multiple && wanted.length !== 1 || new Set(wanted).size !== wanted.length)
              throw new FieldError('select needs distinct option labels or values');
            const selected = wanted.map(v => {
              const exact = state.options.filter(o => o.value === v), matches = exact.length ? exact : state.options.filter(o => o.label === v);
              if (matches.length !== 1 || matches[0].disabled) throw new FieldError('option missing, disabled or ambiguous; read the select');
              return matches[0].value;
            });
            await send(checked => checked.selectOption(selected.map(value => ({ value })), options), 'select');
            if (!stopped) {
              const after = await trustedLocatorRead(loc, inspect, value), actual = after.options.filter(o => o.selected).map(o => o.value);
              if (actual.length !== selected.length || selected.some(v => !actual.includes(v))) throw new FieldError('selection did not match; read the select');
            }
          } else if (state.kind === 'listbox' && state.multiple && Array.isArray(value)) {
            if (new Set(value).size !== value.length) throw new FieldError('multi-select needs distinct option texts');
            const rowsOf = state => {
              const rows = state.options;
              if (state.kind !== 'listbox' || !state.connected || state.disabled || state.readonly || !state.multiple || !rows || rows.length > 1000 ||
                  rows.some((row, i) => !row.label || row.selected === null ||
                    row.size !== null && Number(row.size) !== rows.length || row.position !== null && Number(row.position) !== i + 1) ||
                  new Set(rows.map(row => row.label)).size !== rows.length)
                throw new FieldError('multi-select options missing, ambiguous or incomplete; read the list');
              return rows;
            };
            const rows = rowsOf(state), wanted = rows.map(row => value.includes(row.label));
            if (value.some(label => !rows.some(row => row.label === label)) || rows.some((row, i) => row.disabled && (wanted[i] || row.selected !== wanted[i])))
              throw new FieldError('option missing or disabled; read the list');
            const matches = (actual, selected) => actual.length === rows.length && actual.every((row, i) =>
              row.label === rows[i].label && row.selected === selected[i] && row.disabled === rows[i].disabled);
            let selected = rows.map(row => row.selected);
            for (let i = 0; i < rows.length && !stopped; i++) {
              if (selected[i] === wanted[i]) continue;
              if (!matches(rowsOf(await trustedLocatorRead(loc, inspect, value)), selected)) throw new FieldError('list changed; read it before continuing');
              // Let the page's handler update its own state. Writing aria-selected would bypass frameworks.
              const choice = loc.getByRole('option', { name: rows[i].label, exact: true });
              const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
              await send((checked, target, extra) => checked.click({ ...options, ...extra,
                modifiers: [...new Set([...(extra.modifiers ?? []), modifier])] }), 'click', choice, modifier);
              if (stopped) break;
              await sleep(60);
              selected = selected.map((was, j) => j === i ? wanted[i] : was);
              if (!matches(rowsOf(await trustedLocatorRead(loc, inspect, value)), selected)) throw said('selection did not match; read the list before retrying');
            }
            if (stopped) throw said('selection unconfirmed after a page boundary; read the list');
          } else if (state.kind === 'listbox' || state.kind === 'combo') {
            if (typeof value !== 'string') throw new FieldError(state.kind + ' needs the option text');
            const combo = state.kind === 'combo';
            const handleOf = async (locator, fn, arg) => {
              const handle = await locator.evaluateHandle(fn, arg), element = handle.asElement();
              if (!element) await handle.dispose().catch(() => {});
              return element;
            };
            const popup = () => combo ? handleOf(loc, findPopup) : loc.elementHandle(options);
            const withList = async use => { const list = await popup(); try { return list ? await use(list) : null; } finally { await list?.dispose().catch(() => {}); } };
            const readList = () => withList(list => list.evaluate(readOptions));
            // One scroll-gated search over the whole list: the popup opens by typing, the rows render as the list moves.
            const search = async () => {
              let result;
              await withList(list => send(async checked => { result = await searchOptions({ read: () => checked.evaluate(readOptions), move: to => checked.evaluate(moveList, to), want: value, now, sleep }); }, 'scroll', list));
              return result;
            };
            let result, inner;
            if (combo) {
              if ((state.editableText && state.tag === 'input' || state.innerInput) && /[\r\n]/.test(value)) throw new FieldError(lineBreakRefusal);
              inner = state.editableText ? loc : state.innerInput ? loc.locator('input:not([type="hidden"]), textarea').first() : null;
              const enter = text => inner ? send(checked => checked.fill(text, options), 'type', inner) : send(checked => checked.click(options), 'click');
              const attempts = inner ? queries(value) : [value];
              await enter(attempts[0]);
              // The usual case: the page lists the option under exactly the wanted name.
              if (state.controls && !/[\r\n\0]/.test(state.controls)) {
                const handle = await loc.elementHandle(options);
                try {
                  const frame = await handle.ownerFrame();
                  if (!frame) throw new FieldError('stale frame; read the page');
                  const candidate = frame.locator('[id="' + state.controls.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]').getByRole('option', { name: value, exact: true });
                  const visible = await candidate.waitFor({ ...options, timeout: 500, state: 'visible' }).then(() => true, () => false);
                  if (visible) {
                    if (await candidate.count() !== 1) throw new FieldError('ambiguous option; read the list');
                    await send(checked => checked.click(options), 'click', candidate);
                    if (!stopped && !(await trustedLocatorRead(loc, inspect, value)).matched) throw new FieldError('combobox value did not match; read the field');
                    rows[i].status = 'set'; rows[i].note = 'chose "' + value.slice(0, 80) + '"'; continue;
                  }
                } finally { await handle?.dispose(); }
              }
              for (let a = 0; a < attempts.length && !stopped; a++) {
                if (a > 0) await enter(attempts[a]);
                // Typing filters the list a moment later. Wait until the rows stop changing.
                let before, quiet = 0;
                for (let waited = 0; waited < 1500 && quiet < 4 && !stopped; waited += 60) {
                  const list = await readList(), signature = list ? list.rows.map(row => row.t).join('|') : null;
                  quiet = signature !== null && signature === before ? quiet + 1 : 0; before = signature; if (quiet < 4) await sleep(60);
                }
                if (before === null && a === 0) { await send(checked => checked.click(options), 'click', inner ?? loc); await sleep(120); }
                result = await search();
                if (result?.status === 'found') break;
                if (result && result.status !== 'none') break;
              }
              // A search that found nothing leaves the field holding what was asked for, not the last shorter query.
              if (result?.status !== 'found' && attempts.length > 1 && !stopped) await enter(attempts[0]);
              if (!result) throw said('the combobox opened no option list; the field holds the typed text. Read the page');
            } else result = await search();
            if (result.status !== 'found') throw said(describeMiss(result, value) + (combo ? '; the field holds the text typed while searching' : ''));
            const element = await withList(list => handleOf(list, pickElement, { index: result.index, t: result.row.t, a: result.row.a }));
            if (!element) throw said('the list changed while choosing; read it and try again');
            try { await send(checked => checked.click(options), 'click', element); }
            finally { await element.dispose().catch(() => {}); }
            if (!stopped) {
              await sleep(60);
              if (combo) {
                const shown = (await trustedLocatorRead(inner ?? loc, inspect, value)).current ?? '', want = normalize(result.text), have = normalize(shown);
                if (!have) throw said('the combobox stayed empty after choosing; read the field');
                rows[i].note = 'chose "' + result.text.slice(0, 80) + '"' + (have === want || have === normalize(value) ? '' : '; the field now shows "' + shown.slice(0, 80) + '"');
              } else {
                const list = await readList(), row = list?.rows.find(r => r.v && r.t === result.row.t && r.a === result.row.a);
                if (row && row.s === 'false' && list.rows.some(r => r.s === 'true')) throw said('the option was clicked but is not shown as selected; read the list');
                rows[i].note = 'chose "' + result.text.slice(0, 80) + '"' + (row && row.s === null ? '; the list does not mark its selection' : '');
              }
            }
          } else if (state.kind === 'range') {
            // The model often sends "37" for a slider, so a numeric string counts as the number it spells.
            const wanted = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
            const min = Number(state.min), max = Number(state.max), any = state.type === 'range' && String(state.step).toLowerCase() === 'any';
            const step = any ? 1 : Number(state.step), count = Math.round((wanted - min) / step);
            if (!Number.isFinite(wanted)) throw new FieldError('range needs a number');
            if (![min, max, step].every(Number.isFinite) || step <= 0 || min > max) throw new FieldError('range bounds unreadable; use browser_act keys');
            if (wanted < min || wanted > max) throw new FieldError(`range value ${wanted} is outside ${min} to ${max}`);
            if (!any && Math.abs(min + count * step - wanted) > 1e-8) {
              const lower = min + Math.floor((wanted - min) / step) * step, upper = min + Math.ceil((wanted - min) / step) * step;
              throw new FieldError(`range value ${wanted} is off its step of ${step} from ${min}; nearest valid values are ${upper > max ? lower : lower + ' and ' + upper}`);
            }
            if (state.type === 'range') {
              // A native slider takes its value directly, with the input and change events a drag would fire.
              await send(checked => checked.evaluate((el, next) => {
                const view = el.ownerDocument.defaultView;
                Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value').set.call(el, next);
                for (const type of ['input', 'change']) el.dispatchEvent(new view.Event(type, { bubbles: true }));
              }, String(wanted), options));
            } else {
              if (count > 1000) throw new FieldError('range has too many steps; use browser_act keys');
              await send(checked => checked.press('Home', options), 'press');
              for (let j = 0; j < count && !stopped; j++) await send(checked => checked.press('ArrowRight', options), 'press');
            }
            if (!stopped && (await trustedLocatorRead(loc, inspect, wanted)).number !== wanted) throw new FieldError('range value did not match; read the field');
          } else if (state.kind === 'reorder') {
            const names = await loc.evaluate(order, undefined, options);
            if (!Array.isArray(value) || value.length !== names.length || !names.length || names.length > 100 ||
                new Set(names).size !== names.length || new Set(value).size !== value.length || value.some(v => !names.includes(v)))
              throw new FieldError('reorder needs a complete permutation of distinct row names');
            const children = loc.locator(':scope > li');
            for (let j = 0; j < value.length && !stopped; j++) {
              const current = await loc.evaluate(order, undefined, options), from = current.indexOf(value[j]);
              if (from < 0 || current.length !== names.length) throw new FieldError('list changed; read it before continuing');
              if (from !== j) {
                if (isV3Context(ctx)) await send((checked, target) => ctx.dragTo(target, children.nth(j)), 'drag', children.nth(from));
                else await send(() => children.nth(from).dragTo(children.nth(j), options), 'drag');
              }
            }
            if (!stopped && JSON.stringify(await loc.evaluate(order, undefined, options)) !== JSON.stringify(value)) throw new FieldError('order did not match; read the list');
          } else if (state.kind === 'color') {
            if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new FieldError('color needs a six-digit hex value');
            await send(checked => checked.evaluate((el, color) => {
              const view = el.ownerDocument.defaultView;
              Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value').set.call(el, color);
              for (const type of ['input', 'change']) el.dispatchEvent(new view.Event(type, { bubbles: true }));
            }, value, options));
            if (!stopped && !(await trustedLocatorRead(loc, inspect, value.toLowerCase())).matched) throw new FieldError('color did not match; read the field');
          } else if (state.kind === 'text') {
            if (!['string', 'number'].includes(typeof value)) throw new FieldError('text fields need a string or number');
            if (state.tag === 'input' && /[\r\n]/.test(String(value))) throw new FieldError(lineBreakRefusal);
            await send(checked => checked.fill(String(value), options));
            if (!stopped && !(await trustedLocatorRead(loc, inspect, value)).matched) rows[i].note = 'value was formatted or changed by the page; read it if exact text matters';
          } else throw new FieldError('unsupported field kind; use browser_act');
          rows[i].status = 'set';
        } catch (error) {
          rows[i].status = 'failed';
          // Playwright call logs can contain passwords, card numbers or arbitrary
          // page text. After attempted input report uncertainty without that log.
          rows[i].reason = error.said ? String(error.message).slice(0, 300) : sent ? 'field may have changed; read the page before retrying' : error instanceof FieldError ? String(error.message).slice(0, 200) : 'field unavailable; read the page before retrying';
          stopped ||= 'field failed';
        }
      }
      if (submit !== undefined && !stopped && rows.every(row => row.status === 'set')) {
        try {
          const result = await runSteps(tab, [{ do: 'click', ref: submit }], ctx, onAction ? { onAction } : undefined);
          submitted = { ...result, status: actionFailed(result) ? 'failed' : tab.state.submitUnconfirmed ? 'unconfirmed' : 'done' };
        } catch (error) { submitted = { status: 'failed', reason: /^[A-Z_]+$/.test(error.message) ? error.message : 'submit stopped; read the page before retrying' }; }
      }
      return { rows, submitted, ...(stopped ? { stopped } : {}) };
    } finally { for (const [name, fn] of Object.entries(handlers)) page.off(name, fn); }
  };
}

// Parallel lanes own these siblings. Loading them only at the entry keeps the
// field strategies testable against the fixed interfaces before the join lands.
export async function fillFields(tab, fields, options, ctx) {
  if (!isV3Context(ctx)) throw Error('TRUSTED_TURN_REQUIRED');
  const [{ check, inspectElement }, { runSteps }, { sharedBrowserHand }] = await Promise.all([import('./rules.mjs'), import('./act.mjs'), import('../hand/browser-hand.mjs')]);
  return createFillFields({ check, runSteps, inspectElement, hand: sharedBrowserHand() })(tab, fields, options, ctx);
}

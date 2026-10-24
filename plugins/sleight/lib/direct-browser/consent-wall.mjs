import { cookieWording, declinesCookies, acceptsCookies } from '../consent-wall.mjs';
import { trustedLocatorRead, trustedReadNode, trustedHandle } from './trusted-dom.mjs';

export const consentDecision = "Cookie wall needs the user's decision";

// Inspect only the held target and its ancestors in its own frame. Native
// getters in the isolated utility realm ignore page-overridden DOM APIs.
export function inspectConsent(el, options = {}, read) {
  const attr = (node, key) => read(node, 'getAttribute')?.(key) ?? '';
  const parent = node => read(node, 'parentElement') || read(read(node, 'getRootNode')?.(), 'host');
  const visible = node => {
    if (!read(node, 'isConnected')) return false;
    const rect = read(node, 'getBoundingClientRect')?.();
    const style = read(read(read(node, 'ownerDocument'), 'defaultView'), 'getComputedStyle')?.(node);
    return !!rect?.width && !!rect?.height && style?.display !== 'none' && !/^(?:hidden|collapse)$/.test(style?.visibility);
  };
  const descendants = node => {
    const found = [], visit = root => {
      for (const child of read(root, 'querySelectorAll')?.('*') ?? []) {
        if (found.length >= 20000) return;
        found.push(child);
        const shadow = read(child, 'shadowRoot');
        if (shadow) visit(shadow);
      }
    };
    visit(node);
    const shadow = read(node, 'shadowRoot');
    if (shadow) visit(shadow);
    return found;
  };
  const visibleText = node => {
    const tag = read(node, 'localName');
    return tag === 'input' ? read(node, 'value') || attr(node, 'alt') : read(node, 'innerText') ?? '';
  };
  const words = node => {
    let text = '', visited = 0;
    const visit = current => {
      if (++visited > 20000) return;
      if (read(current, 'nodeType') === 3) { text += ' ' + read(current, 'textContent'); return; }
      if (read(current, 'nodeType') === 1) {
        if (current !== node && boundary(current) || !visible(current)) return;
        text += ' ' + attr(current, 'aria-label');
        if (read(current, 'localName') === 'input') text += ' ' + visibleText(current);
      }
      for (const child of read(current, 'childNodes') ?? []) visit(child);
      const shadow = read(current, 'shadowRoot');
      if (shadow) visit(shadow);
    };
    visit(node);
    return text;
  };
  const name = node => {
    const refs = attr(node, 'aria-labelledby').trim().split(/\s+/).filter(Boolean);
    if (refs.length) {
      const root = read(node, 'getRootNode')();
      return refs.map(id => read(read(root, 'getElementById')?.(id), 'textContent') ?? '').join(' ');
    }
    return attr(node, 'aria-label') || visibleText(node) || attr(node, 'title');
  };
  const control = node => /^(?:button|a|input|select|textarea)$/.test(read(node, 'localName')) ||
    /^(?:button|link|checkbox|radio|switch|menuitem)$/.test(attr(node, 'role'));
  const boundary = node => /^(?:dialog|main|nav|aside|body|html)$/.test(read(node, 'localName')) ||
    /^(?:dialog|alertdialog|region|main|navigation|banner|complementary|contentinfo|form|search)$/.test(attr(node, 'role')) ||
    /^(?:header|footer)$/.test(read(node, 'localName')) || attr(node, 'aria-modal') === 'true' ||
    /^(?:section|form)$/.test(read(node, 'localName')) && !!(attr(node, 'aria-label') || attr(node, 'aria-labelledby'));
  const accepting = node => acceptsCookies(name(node)) || acceptsCookies(visibleText(node));
  const declining = node => !accepting(node) && (declinesCookies(name(node)) || declinesCookies(visibleText(node)));
  if (options.after) return { closed: !visible(el) };
  let target = el;
  while (target && !control(target)) {
    if (boundary(target)) return { blocked: false };
    target = parent(target);
  }
  if (!target) return { blocked: false };
  const accept = accepting(target), decline = declining(target);
  if (!accept && !decline) return { blocked: false };
  let context;
  for (let at = parent(target); at; at = parent(at)) {
    if (cookieWording(words(at))) context ??= at;
    if (boundary(at)) {
      if (context && cookieWording(words(at)) && !/^(?:body|html)$/.test(read(at, 'localName'))) context = at;
      break;
    }
  }
  if (!context) return { blocked: false };
  if (options.container) return context;
  const reject = [context, ...descendants(context)].find(node => control(node) && visible(node) &&
    !read(node, 'disabled') && attr(node, 'aria-disabled') !== 'true' && declining(node));
  return { blocked: accept, wall: true, decline, reject: reject ? name(reject) : undefined };
}
inspectConsent.helpers = [cookieWording, declinesCookies, acceptsCookies];

function consentContainer(el, options, read) { return inspectConsent(el, { container: true }, read); }
consentContainer.helpers = [inspectConsent, ...inspectConsent.helpers];

export async function releaseConsent(state) {
  const held = state.consentObservation;
  delete state.consentObservation;
  try { await held?.dispose(); } catch {}
}

export async function checkConsent(locator, operation, state) {
  // Only activation can accept. Typing and selecting ordinary preferences do
  // not become cookie acceptance merely because a wall is elsewhere on a page.
  if (!/^(?:click|modified click|press|fill)$/.test(operation)) return false;
  const found = await trustedLocatorRead(locator, inspectConsent);
  if (found?.blocked) throw Error(consentDecision + (found.reject
    ? ': accepting cookies is blocked. Use the page control ' + JSON.stringify(found.reject) + ' (untrusted page label) to decline non-essential cookies.'
    : ': this wall has no reject option. Stop and ask the user.'));
  if (!found?.decline || !/^(?:click|press)$/.test(operation)) return false;
  await releaseConsent(state);
  const handle = typeof locator.elementHandle === 'function' ? await locator.elementHandle({ timeout: 1000 }) : locator;
  try { state.consentObservation = await trustedHandle(handle, consentContainer); }
  finally { if (handle !== locator) await handle?.dispose(); }
  return true;
}

export async function verifyConsent(page, state) {
  const held = state.consentObservation;
  // Briefly allow the original wall to finish fading out. Nothing here can
  // authorise input, parse consent storage, or fence future actions.
  const until = Date.now() + 1500;
  const confirmed = 'Decline confirmed: declined non-essential cookies; cookie wall closed';
  try {
    if (held) do {
      const result = await trustedReadNode(held, inspectConsent, { after: true });
      if (result?.closed) return confirmed;
      if (Date.now() >= until) break;
      await new Promise(resolve => setTimeout(resolve, 75));
    } while (true);
  } catch {
    // A removed frame closes its original container, even though its utility
    // context has already gone. Navigation alone does not detach the frame.
    if (held?._frame?._isDetached?.()) return confirmed;
  }
  finally { await releaseConsent(state); }
  return 'Decline unverified: cookie wall closure was not observed';
}

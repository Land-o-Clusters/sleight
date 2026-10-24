import { cookieWording, consentManager, declinesCookies, acceptsCookies } from '../consent-wall.mjs';
import { trustedLocatorRead, trustedRead, trustedReadNode, trustedHandle } from './trusted-dom.mjs';

export const consentDecision = "Cookie acceptance blocked";

// Inspect only the held target and its ancestors in its own frame. Native
// getters in the isolated utility realm ignore page-overridden DOM APIs.
export function inspectConsent(el, options = {}, read) {
  const attr = (node, key) => read(node, 'getAttribute')?.(key) ?? '';
  const parent = node => read(node, 'parentElement') || read(read(node, 'getRootNode')?.(), 'host');
  const style = (node, pseudo) => read(read(read(node, 'ownerDocument'), 'defaultView'), 'getComputedStyle')?.(node, pseudo);
  const visible = node => {
    if (!read(node, 'isConnected')) return false;
    const rect = read(node, 'getBoundingClientRect')?.(), css = style(node);
    return !!rect?.width && !!rect?.height && css?.display !== 'none' && !/^(?:hidden|collapse)$/.test(css?.visibility);
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
    if (read(node, 'localName') === 'input') return read(node, 'value') || attr(node, 'alt');
    const namespace = read(node, 'namespaceURI');
    return namespace && namespace !== 'http://www.w3.org/1999/xhtml' ? read(node, 'textContent') ?? '' : read(node, 'innerText') ?? '';
  };
  const boundary = node => /^(?:dialog|main|nav|aside|body|html)$/.test(read(node, 'localName')) ||
    /^(?:dialog|alertdialog|region|main|navigation|banner|complementary|contentinfo|form|search)$/.test(attr(node, 'role')) ||
    /^(?:header|footer)$/.test(read(node, 'localName')) || attr(node, 'aria-modal') === 'true';
  const words = node => {
    let text = '', visited = 0;
    const visit = current => {
      if (++visited > 20000) return;
      if (read(current, 'nodeType') === 3) { text += ' ' + read(current, 'textContent'); return; }
      if (read(current, 'nodeType') === 1) {
        if (current !== node && boundary(current) || !visible(current) || /^(?:script|style|template)$/.test(read(current, 'localName'))) return;
        if (read(current, 'localName') === 'input') text += ' ' + visibleText(current);
      }
      for (const child of read(current, 'childNodes') ?? []) visit(child);
      const shadow = read(current, 'shadowRoot');
      if (shadow) visit(shadow);
    };
    visit(node);
    return visited > 20000 ? null : text.replace(/\s+/g, ' ').trim();
  };
  const name = node => {
    const refs = attr(node, 'aria-labelledby').trim().split(/\s+/).filter(Boolean);
    if (refs.length) {
      const root = read(node, 'getRootNode')();
      return refs.map(id => read(read(root, 'getElementById')?.(id), 'textContent') ?? '').join(' ');
    }
    return attr(node, 'aria-label') || visibleText(node) || attr(node, 'alt') || attr(node, 'title');
  };
  const labels = node => {
    const result = [name(node), attr(node, 'aria-label'), visibleText(node), attr(node, 'alt')];
    for (const label of read(node, 'labels') ?? []) if (visible(label)) result.push(visibleText(label));
    for (const child of [node, ...descendants(node)]) {
      if (!visible(child)) continue;
      result.push(attr(child, 'alt'));
      // CSS generated text is readable on some pages. Unreadable content is
      // an explicit limit; it never changes the container rule.
      for (const pseudo of ['::before', '::after']) {
        const content = style(child, pseudo)?.content;
        if (content && !/^(?:none|normal)$/.test(content)) result.push(content.replace(/^["']|["']$/g, ''));
      }
    }
    return result;
  };
  const accepting = node => labels(node).some(acceptsCookies);
  const declining = node => !accepting(node) && labels(node).some(declinesCookies);
  const control = node => /^(?:button|a|input|select|textarea|label)$/.test(read(node, 'localName')) ||
    /^(?:button|link|checkbox|radio|switch|menuitem)$/.test(attr(node, 'role')) || !!attr(node, 'onclick');
  const container = node => {
    const cmp = consentManager(attr(node, 'id') + ' ' + attr(node, 'class')) ||
      options.cmpFrame && /^(?:body|html)$/.test(read(node, 'localName'));
    const dialog = read(node, 'localName') === 'dialog' || /^(?:dialog|alertdialog)$/.test(attr(node, 'role')) || attr(node, 'aria-modal') === 'true';
    // A heading or aria-label never supplies banner shape by itself.
    if (cmp) return { node, ask: true };
    if (!dialog && !/^(?:fixed|sticky)$/.test(style(node)?.position)) return;
    if (visibleText(node).replace(/\s+/g, ' ').trim().length >= 1500) return;
    const text = words(node);
    if (text === null || text.length >= 1500 || !cookieWording(text)) return;
    return { node, ask: !!(cmp || dialog) };
  };
  if (options.after) return { closed: !visible(el) };
  let target = el;
  // A page-world onclick property can be unavailable to the trusted reader.
  // A held Accept label still counts without inspecting its handler.
  // Do not promote a wrapper whose text came from other controls.
  const textTarget = !control(target) && accepting(target) && !descendants(target).some(control);
  while (!textTarget && target && !control(target)) {
    if (boundary(target)) return { blocked: false };
    target = parent(target);
  }
  if (!target) return { blocked: false };
  const accept = accepting(target), decline = declining(target);
  if (!accept && !decline) return { blocked: false };
  let context;
  for (let at = parent(target); at; at = parent(at)) {
    context = container(at);
    if (context || boundary(at)) break;
  }
  if (!context) return { blocked: false };
  if (options.container) return context.node;
  const within = node => {
    for (let at = parent(node); at && at !== context.node; at = parent(at)) if (boundary(at)) return false;
    return true;
  };
  const reject = descendants(context.node).find(node => control(node) && visible(node) && within(node) &&
    !read(node, 'disabled') && attr(node, 'aria-disabled') !== 'true' && declining(node));
  return { blocked: accept, wall: true, decline, ask: context.ask, reject: reject ? labels(reject).find(declinesCookies) : undefined };
}
inspectConsent.helpers = [cookieWording, consentManager, declinesCookies, acceptsCookies];

function consentContainer(el, options, read) { return inspectConsent(el, { ...options, container: true }, read); }
consentContainer.helpers = [inspectConsent, ...inspectConsent.helpers];

function cmpFrameIdentity(el, options, read) {
  return consentManager(['id', 'class', 'name'].map(key => read(el, 'getAttribute')?.(key) ?? '').join(' '));
}
cmpFrameIdentity.helpers = [consentManager];

async function frameOptions(handle) {
  let frameElement;
  try {
    const frame = await handle?.ownerFrame?.();
    if (!frame?.parentFrame?.()) return {};
    frameElement = await frame.frameElement();
    return { cmpFrame: !!await trustedLocatorRead(frameElement, cmpFrameIdentity) };
  } finally { await frameElement?.dispose(); }
}

export async function releaseConsent(state) {
  const held = state.consentObservation;
  delete state.consentObservation;
  try { await held?.dispose(); } catch {}
}

export async function checkConsent(locator, operation, state) {
  if (!/^(?:click|modified click|press|fill|check)$/.test(operation)) return false;
  const handle = typeof locator.elementHandle === 'function' ? await locator.elementHandle({ timeout: 1000 }) : locator;
  try {
    let options = {}, found = await trustedRead(handle, inspectConsent);
    if (!found?.wall) {
      options = await frameOptions(handle);
      if (options.cmpFrame) found = await trustedRead(handle, inspectConsent, options);
    }
    if (found?.blocked) throw Error(consentDecision + (found.reject
      ? ': accepting cookies is blocked. Use the page control ' + JSON.stringify(found.reject) + ' (untrusted page label) to decline non-essential cookies.'
      : found.ask ? ': accepting cookies is blocked. This wall has no reject option. Stop and ask the user.'
      : ': accepting cookies is blocked. No one-click decline was observed in this cookie container.'));
    if (!found?.decline || !/^(?:click|press)$/.test(operation)) return false;
    await releaseConsent(state);
    state.consentObservation = await trustedHandle(handle, consentContainer, options);
    return true;
  } finally { if (handle !== locator) await handle?.dispose(); }
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

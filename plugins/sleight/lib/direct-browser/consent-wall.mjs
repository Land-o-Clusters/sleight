import { cookieWording, declinesCookies, acceptedCookies, consentRecord } from '../consent-wall.mjs';
import { trustedLocatorRead } from './trusted-dom.mjs';

export const consentDecision = "Cookie wall needs the user's decision";

// Runs only in the pristine utility realm. All DOM reads use native getters,
// including when following an open shadow root or a same-origin frame.
export function inspectConsent(el, options = {}, read) {
  const attr = (node, key) => read(node, 'getAttribute')?.(key) ?? '';
  const parent = node => {
    const element = read(node, 'parentElement');
    if (element) return element;
    const root = read(node, 'getRootNode')?.(), host = read(root, 'host');
    if (host) return host;
    try { return read(read(root, 'defaultView'), 'frameElement'); } catch { return undefined; }
  };
  const under = (node, root) => {
    for (let at = node; at; at = parent(at)) if (at === root) return true;
    return false;
  };
  const visible = node => {
    const rect = read(node, 'getBoundingClientRect')(), doc = read(node, 'ownerDocument');
    const style = read(read(doc, 'defaultView'), 'getComputedStyle')(node);
    return !!rect.width && !!rect.height && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const words = node => {
    let text = attr(node, 'aria-label') + ' ' + (read(node, 'innerText') ?? read(node, 'textContent') ?? '');
    for (const child of read(node, 'querySelectorAll')?.('*') ?? []) {
      const shadow = read(child, 'shadowRoot');
      if (shadow) text += ' ' + read(shadow, 'textContent');
    }
    const shadow = read(node, 'shadowRoot');
    if (shadow) text += ' ' + read(shadow, 'textContent');
    return text;
  };
  const name = node => {
    const refs = attr(node, 'aria-labelledby').trim().split(/\s+/).filter(Boolean);
    if (refs.length) {
      const root = read(node, 'getRootNode')();
      return refs.map(id => read(read(root, 'getElementById')?.(id), 'textContent') ?? '').join(' ');
    }
    return attr(node, 'aria-label') || (read(node, 'localName') === 'input' ? attr(node, 'value') || attr(node, 'alt') : read(node, 'innerText')) || attr(node, 'title') || '';
  };
  const declineControl = node => {
    const tag = read(node, 'localName'), role = attr(node, 'role');
    return (tag === 'button' || tag === 'a' || /^(?:button|link)$/.test(role) ||
      tag === 'input' && /^(?:button|submit|image)$/.test(read(node, 'type'))) && declinesCookies(name(node));
  };
  let doc = read(el, 'ownerDocument'), crossOrigin = false;
  // A cross-origin target cannot prove its relation to the top document.
  try { doc = read(read(read(doc, 'defaultView'), 'top'), 'document') ?? doc; } catch { crossOrigin = true; }
  const walls = [], opaque = [], docs = [], controls = [], seen = new Set();
  let visited = 0, incomplete = false, settingsHeading = false, settingsControl = false;
  const scan = (root, frames = []) => {
    if (seen.has(root)) return;
    seen.add(root);
    if (read(root, 'nodeType') === 9) docs.push(root);
    for (const node of read(root, 'querySelectorAll')('*')) {
      if (++visited > 20000) { incomplete = true; return; }
      const shadow = read(node, 'shadowRoot');
      if (shadow) scan(shadow, frames);
      if (!visible(node)) continue;
      const tag = read(node, 'localName'), role = attr(node, 'role');
      if (/^(?:button|a|input)$/.test(tag) || /^(?:button|link)$/.test(role)) controls.push(node);
      if (options.after && (/^h[1-6]$/.test(tag) || role === 'heading') && cookieWording(words(node))) settingsHeading = true;
      if (options.after && (/^(?:button|input|select)$/.test(tag) || /^(?:button|checkbox|switch|radio)$/.test(role))) settingsControl = true;
      const look = read(read(read(node, 'ownerDocument'), 'defaultView'), 'getComputedStyle')(node);
      const structural = tag === 'dialog' || /^(?:dialog|alertdialog)$/.test(role) || attr(node, 'aria-modal') === 'true' ||
        /^(?:fixed|sticky)$/.test(look.position) && !/^(?:button|a|input|svg|span)$/.test(tag);
      if (structural && cookieWording(words(node))) walls.push({ node, frames });
      if (tag === 'iframe' || tag === 'frame') {
        let inner;
        try { inner = read(node, 'contentDocument'); } catch {}
        if (inner) scan(inner, [...frames, node]);
        else if (cookieWording(attr(node, 'title') + ' ' + attr(node, 'aria-label')) || walls.some(wall => under(node, wall.node))) opaque.push(node);
      }
    }
  };
  scan(doc);
  let closedTarget = false;
  // A held accessibility ref can expose a node in a closed root even though
  // document traversal cannot. Inspect that root to stop unsafe input, but
  // hand its wall to the user: replacement settings cannot be reread from the
  // document after the original control is detached.
  for (let at = el; at;) {
    const root = read(at, 'getRootNode')?.();
    if (read(root, 'nodeType') !== 11) break;
    closedTarget ||= read(root, 'mode') === 'closed';
    scan(root);
    at = read(root, 'host');
  }
  if (options.after) {
    // Return only a classification. Cookie and storage values never leave this
    // reader or enter an outcome, trace or model-visible snapshot.
    let accepted = false;
    for (const current of docs) {
      const body = read(current, 'body');
      if (body && acceptedCookies(words(body))) accepted = true;
      const cookies = String(read(current, 'cookie') ?? '');
      for (const pair of cookies.split(';')) {
        const at = pair.indexOf('='), result = consentRecord(pair.slice(0, at), pair.slice(at + 1));
        if (result === 'accepted') accepted = true;
        if (result === 'unknown') incomplete = true;
      }
      const view = read(current, 'defaultView');
      for (const key of ['localStorage', 'sessionStorage']) try {
        const storage = read(view, key);
        const length = Object.getOwnPropertyDescriptor(Storage.prototype, 'length').get.call(storage);
        for (let i = 0; i < Math.min(length, 256); i++) {
          const item = Storage.prototype.key.call(storage, i);
          const result = consentRecord(item, Storage.prototype.getItem.call(storage, item));
          if (result === 'accepted') accepted = true;
          if (result === 'unknown') incomplete = true;
        }
        if (length > 256) incomplete = true;
      } catch { incomplete = true; }
    }
    return { blocked: incomplete || crossOrigin || !!walls.length || !!opaque.length || settingsHeading && settingsControl || accepted, accepted };
  }
  const inside = walls.some(wall => under(el, wall.node) || wall.frames.some(frame => under(el, frame)) ||
    (() => { let view = read(read(el, 'ownerDocument'), 'defaultView');
      for (;;) { let frame; try { frame = read(view, 'frameElement'); } catch { return false; }
        if (!frame) return false; if (under(frame, wall.node)) return true; view = read(read(frame, 'ownerDocument'), 'defaultView'); }
    })());
  if (incomplete || crossOrigin || opaque.length || closedTarget && inside || walls.some(wall => !controls.some(node => under(node, wall.node) && declineControl(node)))) return { blocked: true };
  if (!inside) return { blocked: false };
  let control = el;
  while (control && !/^(?:button|a|input)$/.test(read(control, 'localName')) && !/^(?:button|link)$/.test(attr(control, 'role'))) control = parent(control);
  return { wall: true, decline: !!control && declineControl(control) };
}
inspectConsent.helpers = [cookieWording, declinesCookies, acceptedCookies, consentRecord];

export async function checkConsent(locator, operation, state) {
  if (state.consentStopped) throw Error(consentDecision + ': the previous decline was unverified. Hand off to the user.');
  let found;
  try { found = await trustedLocatorRead(locator, inspectConsent); }
  catch { throw Error(consentDecision + ': cookie-wall state could not be checked. Stop and ask.'); }
  if (!found || found.blocked !== false && found.wall !== true || found.blocked || found.wall && (operation !== 'click' || !found.decline))
    throw Error(consentDecision + ': only a one-click Reject or necessary-only control may decline all non-essential cookies. Stop and ask.');
  return found.wall === true;
}

export async function verifyConsent(page, state) {
  let result;
  try { result = await trustedLocatorRead(page.locator(':root'), inspectConsent, { after: true }); } catch {}
  if (!result || result.blocked) {
    state.consentStopped = true;
    throw Error(consentDecision + (result?.accepted ? ': the page reports accepting cookies after Reject. Stop and ask.'
      : ': decline unverified, wall remains, or settings opened. Stop and ask.'));
  }
  return 'Declined non-essential cookies; cookie wall disappeared';
}

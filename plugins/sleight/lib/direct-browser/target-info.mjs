// Only risk classification and a comparison fingerprint cross this boundary.
// Form values never enter an outcome line or a snapshot through this reader.
export function inspectTarget(el, unused, read = (node, key) => { const value = node?.[key]; return typeof value === 'function' ? value.bind(node) : value; }) {
  const words = node => [read(node, 'getAttribute')('aria-label'), read(node, 'textContent'), read(node, 'getAttribute')('value')].filter(Boolean).join(' ');
  const payment = text => /\b(?:pay|payment|purchase|buy|checkout|donate|subscribe|place order|complete order|order now|book now|upgrade|send money|charge)\b/i.test(text);
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
  const labelControl = (() => {
    if (typeof HTMLLabelElement === 'undefined') return null;
    const label = read(el, 'closest')('label');
    if (!label) return null;
    const interactive = 'a[*|href],audio[controls],button,details,embed,iframe,img[usemap],input:not([type="hidden"]),label,select,textarea,video[controls]';
    for (let at = el; at && at !== label; at = read(at, 'parentElement')) if (read(at, 'matches')(interactive)) return null;
    return read(label, 'control');
  })();
  const activation = labelControl || el;
  const formOf = () => {
    const owner = read(activation, 'form');
    if (owner) return owner;
    if (owner === undefined) return enclosing(el, 'form');
    const root = read(el, 'getRootNode')?.();
    return root && read(root, 'nodeType') === 11 ? enclosing(read(root, 'host'), 'form') : owner;
  };
  const form = formOf(), tag = read(el, 'localName'), role = read(el, 'getAttribute')('role'), name = words(el).trim().slice(0, 100);
  const accName = (read(el, 'getAttribute')('aria-labelledby') ? '' : (read(el, 'getAttribute')('aria-label') || read(el, 'textContent') || read(el, 'getAttribute')('value') || read(el, 'getAttribute')('alt') || read(el, 'getAttribute')('title') || '')).replace(/\s+/g, ' ').trim().slice(0, 100);
  const button = tag === 'button' || tag === 'input' && /^(?:button|submit|image)$/.test(read(el, 'type')) || role === 'button';
  // A label click forwards to its control, so a label for a file or color input opens the native picker like the input does.
  const forwarded = (() => { try { const label = typeof HTMLLabelElement === 'undefined' ? null : Element.prototype.closest.call(el, 'label'), control = label && Object.getOwnPropertyDescriptor(HTMLLabelElement.prototype, 'control').get.call(label);
    return control instanceof HTMLInputElement ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'type').get.call(control).toLowerCase() : ''; } catch { return ''; } })();
  const formPayment = !!form && [...read(form, 'querySelectorAll')('input,button,iframe')].some(node => {
    // Any frame in a form may hold hosted payment fields (default path unchanged by fd2f).
    if (read(node, 'localName') === 'iframe') return true;
    return /^cc-/i.test(read(node, 'getAttribute')('autocomplete') ?? '') || /(?:card|cc[-_ ]?(?:number|csc)|cvv|cvc)/i.test(read(node, 'id') + ' ' + read(node, 'getAttribute')('name')) ||
      (read(node, 'localName') === 'button' || read(node, 'type') === 'submit') && payment(words(node));
  });
  // navigate follows only a plain http(s) link; any other scheme, or an element with no href, is a click's job.
  const link = (() => { try { if (tag !== 'a' && tag !== 'area') return false; const href = read(el, 'getAttribute')('href'); if (href == null) return false;
    const url = new URL(href, read(read(el, 'ownerDocument'), 'baseURI')); return /^https?:$/.test(url.protocol) && !url.username && !url.password; } catch { return false; } })();
  const submit = !!(button && (read(el, 'type') === 'submit' && form || /\b(?:save|submit|send|confirm|book|pay|place order|finish|complete)\b/i.test(name) || payment(name)));
  const scriptButton = !submit && !!(button && form && formPayment && read(el, 'type') !== 'reset');
  let hash = 2166136261;
  if (form) {
    const content = read(form, 'textContent') + [...read(form, 'querySelectorAll')('input,select,textarea')].map(n => [read(n, 'value'), read(n, 'checked'), read(n, 'selectedIndex')].join(':')).join('|');
    for (let i = 0; i < content.length; i++) hash = Math.imul(hash ^ content.charCodeAt(i), 16777619);
  }
  const nativeActivation = implicit => {
    const nativeURL = (node, href) => {
      if (!href) return false;
      try { return !/^(https?|javascript|blob|data|about):$/.test(new URL(href, read(read(node, 'ownerDocument'), 'baseURI')).protocol); }
      catch { return true; }
    };
    const anchor = ['a', 'area'].includes(tag) ? el : read(el, 'closest')('a,area[href]');
    if (anchor && nativeURL(anchor, read(anchor, 'getAttribute')('href') || read(anchor, 'getAttributeNS')?.('http://www.w3.org/1999/xlink', 'href'))) return true;
    if (!form) return false;
    const isSubmitter = node => read(node, 'localName') === 'button' && !/^(button|reset)$/.test(read(node, 'type') ?? '') ||
      read(node, 'localName') === 'input' && /^(submit|image)$/.test(read(node, 'type') ?? '');
    const control = isSubmitter(activation) ? activation : read(activation, 'closest')('button,input');
    const explicit = control && isSubmitter(control);
    if (!explicit && !(implicit && tag === 'input' && /^(text|search|tel|url|email|password|date|month|week|time|datetime-local|number|checkbox|radio|range)$/.test(read(el, 'type') ?? 'text'))) return false;
    const root = read(form, 'getRootNode')?.() ?? read(form, 'ownerDocument'), query = read(root, 'querySelectorAll');
    const candidates = query ? [...query('button,input')].filter(node => read(node, 'form') === form) : [...read(form, 'querySelectorAll')('button,input')];
    const submitter = control && isSubmitter(control) ? control : candidates.find(isSubmitter);
    const override = submitter && read(submitter, 'getAttribute')('formaction');
    return nativeURL(form, override == null ? read(form, 'getAttribute')('action') : override);
  };
  const appLink = nativeActivation(false), nativeFormEnter = nativeActivation(true);
  return { name, accName, tag, role, inputType: read(el, 'type') ?? '', cursorTitle: read(el, 'getAttribute')('title') ?? '', cursorDescription: read(el, 'getAttribute')('aria-description') ?? '', appLink, nativeFormEnter, kind: ['file', 'color'].includes(forwarded) ? forwarded : button ? 'button' : ['file', 'color'].includes(read(el, 'type')) ? read(el, 'type') : tag === 'select' ? 'select' : 'text', button, form: !!form, link, submit: submit || scriptButton, scriptButton, payment: payment(name) || submit && formPayment,
    // An anchor whose only payment word is "checkout": the trusted context may drop this as the prior of a released navigation link (v3-context).
    checkoutLink: tag === 'a' && payment(name) && (name.match(/\b(?:pay|payment|purchase|buy|checkout|donate|subscribe|place order|complete order|order now|book now|upgrade|send money|charge)\b/gi) ?? []).every(word => word.toLowerCase() === 'checkout'),
    formPayment, formSignature: form ? hash : null };
}

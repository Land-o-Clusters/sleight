import { snapshotRefBinding, readSnapshotSecrets, scrub } from './snapshot.mjs';
import { trustedReadNode } from './trusted-dom.mjs';
import { assertEndpointRead } from './endpoint-guard.mjs';
import { EXPORT_LIMITS, writeDataExport, exportSummary } from './export-file.mjs';

// Runs synchronously in Playwright's pristine utility world. No page functions, getters, scrolling or input.
export function readExportCollection(el, limits, read) {
  const attribute = (node, name) => read(node, 'getAttribute')?.(name);
  const tag = node => read(node, 'localName');
  const role = node => (attribute(node, 'role') ?? '').trim().toLowerCase().split(/\s+/)[0];
  const collection = node => /^(table|ul|ol)$/.test(tag(node)) || /^(table|grid|treegrid|list|listbox|log|feed)$/.test(role(node));
  const table = tag(el) === 'table' || /^(table|grid|treegrid)$/.test(role(el));
  if (!read(el, 'isConnected') || !collection(el)) throw Error('Export ref must name a table, grid or list');
  const reasons = new Set(), rows = [], indices = [], totals = [], hidden = new WeakMap();
  let nodes = 0, characters = 0, redacted = false, capped = false;
  const sensitive = /password|passcode|secret|one.?time|\botp\b|\bcc[-_ ]|card|expiry|expiration|cvv|cvc|security.?code/i;
  const children = node => Array.from(read(node, 'children') ?? []);
  const branches = node => tag(node) === 'slot' ? HTMLSlotElement.prototype.assignedElements.call(node, { flatten: true }) : children(read(node, 'shadowRoot') ?? node);
  const parent = node => read(node, 'parentElement') ?? read(read(node, 'getRootNode')?.(), 'host');
  const visible = node => {
    if (!node || read(node, 'nodeType') !== 1) return true;
    if (hidden.has(node)) return hidden.get(node);
    const style = getComputedStyle(node);
    let yes = !read(node, 'hasAttribute')?.('hidden') && attribute(node, 'aria-hidden') !== 'true' &&
      style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility) && style.contentVisibility !== 'hidden' && visible(parent(node));
    if (yes) {
      const boxes = Array.from(read(node, 'getClientRects')?.() ?? []);
      const positioned = /^(absolute|fixed)$/.test(style.position);
      const geometry = tag(node) === 'br' || style.display === 'contents' || boxes.some(box => box.width > 0 && box.height > 0 && box.right + scrollX > 0 && box.bottom + scrollY > 0 &&
        (!positioned || box.left < innerWidth && box.top < innerHeight));
      if (!geometry || Number(style.opacity) === 0 || parseFloat(style.fontSize) === 0 || style.clip !== 'auto' && style.clip !== '' ||
          style.clipPath !== 'none' && style.clipPath !== '') {
        yes = false; reasons.add('visually hidden text omitted');
      }
    }
    hidden.set(node, yes); return yes;
  };
  if (!visible(el)) throw Error('Export collection is hidden');
  const integer = value => /^\d+$/.test(value ?? '') && Number(value) <= 1000000000 ? Number(value) : undefined;
  const inspect = node => {
    if (attribute(node, 'aria-busy') === 'true' || role(node) === 'progressbar') reasons.add('collection contains a loading indicator');
    if (role(node) === 'navigation' || tag(node) === 'nav' || /\bnext\b/i.test(attribute(node, 'rel') ?? '')) reasons.add('nearby pagination control');
    const countText = children(node).length <= 8 && /^(span|p|div|nav|a|button)$/.test(tag(node)) ? (read(node, 'textContent') ?? '').slice(0, 160) : '';
    if (/\bpage\s+\d+\s+(?:of|\/)\s*\d+\b/i.test((attribute(node, 'aria-label') ?? '') + ' ' + countText)) reasons.add('nearby pagination page count');
    if (/^(button|a)$/.test(tag(node)) || role(node) === 'button') {
      const label = (attribute(node, 'aria-label') ?? read(node, 'textContent') ?? '').slice(0, 120).trim();
      if (/^(?:(?:load|show|view|see|read)\s+(?:\d+\s+)?(?:more|older|newer)\b|next(?:\s+page)?$|older\b|newer\b)/i.test(label)) reasons.add('unopened pagination or expansion control');
    }
  };
  const total = integer(attribute(el, table ? 'aria-rowcount' : 'aria-setsize'));
  if (total !== undefined) totals.push(total);
  if (attribute(el, table ? 'aria-rowcount' : 'aria-setsize') === '-1') reasons.add('page declares an unknown total');
  if (attribute(el, 'aria-busy') === 'true') reasons.add('collection is busy');
  const visit = (node, callback, depth = 0) => {
    if (++nodes > 50000 || depth > 96) { capped = true; reasons.add('DOM budget reached'); return; }
    if (attribute(node, 'aria-busy') === 'true' || role(node) === 'progressbar') reasons.add('collection contains a loading indicator');
    if (!visible(node)) return;
    inspect(node);
    if (node !== el && collection(node)) { reasons.add('nested collection omitted'); return; }
    if (callback(node) === false) return;
    for (const child of branches(node)) visit(child, callback, depth + 1);
  };
  const text = node => {
    const parts = [];
    const scan = (current, depth = 0) => {
      if (++nodes > 50000 || depth > 96) { capped = true; reasons.add('DOM budget reached'); return; }
      const type = read(current, 'nodeType');
      if (type === 3) {
        const raw = read(current, 'nodeValue') ?? '', room = limits.characters - characters;
        const value = raw.slice(0, Math.max(0, room)); parts.push(value); characters += value.length;
        if (value.length < raw.length) { capped = true; reasons.add('text budget reached'); }
        return;
      }
      if (type !== 1 && type !== 11 || type === 1 && !visible(current)) return;
      if (type === 1) inspect(current);
      if (/^(script|style|template|noscript)$/.test(tag(current))) return;
      if (/^(canvas|svg|iframe|object|embed|img)$/.test(tag(current))) { reasons.add('non-text content omitted'); return; }
      const mask = getComputedStyle(current).webkitTextSecurity;
      if (mask && mask !== 'none') {
        parts.push('[redacted]'); redacted = true; reasons.add('masked content redacted'); return;
      }
      const control = /^(input|textarea|select|button|output)$/.test(tag(current)) || /^(textbox|searchbox|combobox|spinbutton)$/.test(role(current)) || read(current, 'isContentEditable');
      if (/^(input|textarea|select)$/.test(tag(current)) || read(current, 'isContentEditable') ||
        /(?:^|\s)cc-/i.test(attribute(current, 'autocomplete') ?? '') || control && sensitive.test([
          attribute(current, 'type'), attribute(current, 'name'), attribute(current, 'id'), attribute(current, 'autocomplete'), attribute(current, 'aria-label')].join(' '))) {
        parts.push('[redacted]'); redacted = true; return;
      }
      if (current !== node && collection(current)) { reasons.add('nested collection omitted'); return; }
      if (tag(current) === 'br') { parts.push('\n'); return; }
      const shadow = read(current, 'shadowRoot');
      if (tag(current)?.includes('-') && !shadow) reasons.add('custom element may contain unreadable content');
      const content = tag(current) === 'slot' ? HTMLSlotElement.prototype.assignedNodes.call(current, { flatten: true }) : Array.from(read(shadow ?? current, 'childNodes') ?? []);
      for (const child of content) scan(child, depth + 1);
      if (/^(div|p|li)$/.test(tag(current))) parts.push('\n');
    };
    scan(node);
    return parts.join('').replace(/[\t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').trim();
  };
  const records = [];
  const nonItem = node => /^(button|a|input|select|textarea|script|style|template|progress)$/.test(tag(node)) || /^(button|progressbar|status|alert)$/.test(role(node));
  visit(el, node => {
    if (node === el) return;
    const row = table ? tag(node) === 'tr' || role(node) === 'row' : tag(node) === 'li' || /^(listitem|option|article)$/.test(role(node));
    if (!row || nonItem(node)) return;
    if (records.length > limits.rows) { reasons.add('row budget reached'); return false; }
    records.push(node); return false;
  });
  // A log/feed may use ordinary direct children without ARIA item roles.
  if (!table && !records.length) records.push(...branches(el).filter(node => visible(node) && !nonItem(node)).slice(0, limits.rows + 1));
  let columns = [], headers = 0;
  for (const record of records) {
    let cells = [], header = false;
    if (table) {
      visit(record, node => {
        if (node === record) return;
        if (/^(td|th)$/.test(tag(node)) || /^(cell|gridcell|columnheader|rowheader)$/.test(role(node))) { cells.push(node); return false; }
      });
      header = cells.length > 0 && cells.every(node => tag(node) === 'th' && attribute(node, 'scope') !== 'row' || role(node) === 'columnheader');
      if (cells.length > limits.columns) { reasons.add('column budget reached'); cells = cells.slice(0, limits.columns); }
      if (cells.some(node => ['rowspan', 'colspan', 'aria-rowspan', 'aria-colspan'].some(key => Number(attribute(node, key)) > 1))) reasons.add('spanning cells kept as single cells');
    } else cells = [record];
    if (rows.length >= limits.rows && !header) { reasons.add('row budget reached'); break; }
    const row = cells.map(text);
    if (header && !columns.length && !rows.length) { columns = row; headers++; continue; }
    if (header) reasons.add('additional header rows kept as data');
    if (!row.length) { reasons.add('row has no readable cells'); continue; }
    rows.push(row);
    const nativeIndex = integer(attribute(record, table ? 'aria-rowindex' : 'aria-posinset'));
    const dataIndex = integer(attribute(record, 'data-index') ?? attribute(record, 'data-row-index'));
    const index = nativeIndex ?? (dataIndex === undefined ? undefined : dataIndex + 1);
    if (index !== undefined) indices.push(index);
    const count = integer(attribute(record, table ? 'aria-rowcount' : 'aria-setsize'));
    if (count !== undefined) totals.push(count);
    if (attribute(record, 'aria-setsize') === '-1' || attribute(record, 'aria-busy') === 'true') reasons.add('row total unknown or row busy');
    if (capped) break;
  }
  const expected = totals.length ? Math.max(...totals) : undefined, rendered = rows.length + headers;
  if (new Set(totals).size > 1) reasons.add('page declares conflicting totals');
  if (expected !== undefined && expected > rendered) reasons.add(`${expected - rendered} rows not rendered (virtualized or paginated collection)`);
  if (expected !== undefined && expected < rendered) reasons.add('rendered count exceeds the declared total');
  if (indices.some((value, i) => value < 1 || i > 0 && value !== indices[i - 1] + 1) || indices.length && indices[0] > 1 + headers) reasons.add('row index gaps or missing beginning');
  if (indices.length && indices.length !== rows.length) reasons.add('some row indices are missing');
  if (indices.length && expected === undefined) reasons.add('indexed collection has no declared total');
  if (rows.some(row => row.length !== (columns.length || rows[0]?.length))) reasons.add('ragged rows have different cell counts');
  // Scroll, pagination and content behind controls need a separate whole read; a DOM read cannot prove them complete.
  if (expected === undefined) {
    const nearby = (node, depth = 0) => {
      if (++nodes > 50000 || depth > 96) { reasons.add('DOM budget reached'); return; }
      if (node === el || collection(node) || !visible(node)) return;
      inspect(node);
      for (const child of branches(node)) nearby(child, depth + 1);
    };
    for (let node = el, depth = 0; node && depth < 96; node = parent(node), depth++) {
      // A document's ordinary viewport is not evidence that the collection itself is virtualized.
      if (/^(body|html)$/.test(tag(node))) break;
      if ((read(node, 'scrollHeight') ?? 0) > (read(node, 'clientHeight') ?? 0) + 1 ||
          (read(node, 'scrollWidth') ?? 0) > (read(node, 'clientWidth') ?? 0) + 1) reasons.add('scrolling collection has no declared total');
      const style = getComputedStyle(node);
      const overflow = /^(auto|scroll|hidden|clip)$/.test(style.overflowX) || /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
      // Siblings at each wrapper, including the scroller's children, can hold pagination outside the collection.
      if (node === el) for (const sibling of branches(parent(node))) nearby(sibling);
      else for (const child of branches(node)) nearby(child);
      if (overflow) break;
    }
  }
  if (!rows.length) reasons.add('no readable data rows');
  return { kind: table ? 'table' : 'list', columns, rows, complete: reasons.size === 0, reasons: [...reasons], redacted };
}

export async function readDataExport(page, ref, { endpoint, check = () => {} } = {}) {
  if (typeof ref !== 'string' || !/^(?:f\d+)?e\d+$/.test(ref)) throw Error('Export needs an observed table, grid or list ref');
  if (!/^https?:\/\//.test(page.url())) throw Error('Structured export is browser-only; native document content stays on the engine path');
  await check(); await assertEndpointRead(page, endpoint);
  const url = page.url(), frame = page.mainFrame(), locator = snapshotRefBinding(page, ref);
  let changed = false;
  const change = () => { changed = true; };
  page.on('framenavigated', change); page.on('close', change);
  try {
    const secrets = await readSnapshotSecrets(page);
    // Client elementHandle() adopts into MAIN and generates a preview that can invoke page getters. Keep the
    // exact delivered aria-ref in the pinned server's utility world through acquisition, read and disposal.
    const clientFrame = locator._frame, frameImpl = clientFrame?._connection?.toImpl?.(clientFrame);
    if (!frameImpl || frameImpl._page?.delegate?.noUtilityWorld?.() || !/^aria-ref=(?:f\d+)?e\d+$/.test(locator._selector)) throw Error('TRUSTED_DOM_REQUIRED');
    const resolved = await frameImpl.selectors.callOnSelectorHandle({ selector: locator._selector, strict: true }, ({ elements }) => elements[0], {});
    const handle = resolved?.result, node = handle?.asElement?.();
    let data;
    try {
      if (!node || node._context?.world !== 'utility' || !/^(?:https?:\/\/|about:(?:srcdoc|blank)$)/.test(resolved.frame.url())) throw Error('TRUSTED_DOM_REQUIRED');
      data = await trustedReadNode(node, readExportCollection, EXPORT_LIMITS);
    } finally { await handle?.dispose(); }
    let redacted = data.redacted;
    const scrubCell = value => { const safe = scrub(value, secrets); redacted ||= safe !== value; return safe; };
    data.columns = data.columns.map(scrubCell); data.rows = data.rows.map(row => row.map(scrubCell));
    if (redacted) {
      data.complete = false; data.reasons.push('protected content redacted');
    }
    if (secrets.hasClosed) {
      data.complete = false; data.reasons.push('page contains closed shadow content; export may omit it');
    }
    await check(); await assertEndpointRead(page, endpoint);
    if (changed || url !== page.url() || page.mainFrame() !== frame || page.isClosed()) throw Error('Page changed during export; read again');
    return data;
  } catch (error) {
    if (error.message === 'blocked: DevTools endpoint' || error.siteBlocked) throw error;
    // Utility errors can contain page-supplied strings. Return only fixed local failure text.
    throw Error('Export read unavailable; use a fresh table, grid or list ref');
  } finally { page.off('framenavigated', change); page.off('close', change); }
}

export async function exportPageData(entry, options, ctx, { endpoint, check } = {}) {
  if (entry.state.actionPending || entry.state.dialog) throw Error('Input or dialog pending; export refused');
  const data = await readDataExport(entry.page, options.export, { endpoint, check });
  await check?.();
  return exportSummary(writeDataExport(data, options, ctx));
}

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
  const reasons = new Set(), signals = new Set(), rows = [], indices = [], totals = [], textTotals = [], observedTotals = [], hidden = new WeakMap();
  let nodes = 0, characters = 0, redacted = false, capped = false;
  const sensitive = /password|passcode|secret|one.?time|\botp\b|\bcc[-_ ]|card|expiry|expiration|cvv|cvc|(?:security|verification).?code/i;
  const children = node => Array.from(read(node, 'children') ?? []);
  const branches = node => tag(node) === 'slot' ? HTMLSlotElement.prototype.assignedElements.call(node, { flatten: true }) : children(read(node, 'shadowRoot') ?? node);
  const parent = node => read(node, 'parentElement') ?? read(read(node, 'getRootNode')?.(), 'host');
  const document = read(el, 'ownerDocument');
  const scroller = read(document, 'scrollingElement') ?? read(document, 'documentElement');
  const width = Math.max(innerWidth, read(scroller, 'scrollWidth') ?? 0);
  const height = Math.max(innerHeight, read(scroller, 'scrollHeight') ?? 0);
  // Client rects are viewport-relative. Compare them with the whole scrollable document, without scrolling it.
  const onCanvas = box => box.width > 0 && box.height > 0 && box.left + scrollX >= -9999 && box.top + scrollY >= -9999 &&
    box.right + scrollX > 0 && box.bottom + scrollY > 0 && box.left + scrollX < width && box.top + scrollY < height;
  const zeroClip = (style, box) => {
    const length = (value, extent) => /^-?[\d.]+(?:px|%)?$/.test(value) ? parseFloat(value) * (value.endsWith('%') ? extent / 100 : 1) : NaN;
    const rect = /^rect\((.*)\)$/.exec(style.clip)?.[1].split(/,\s*|\s+/);
    if (/^(absolute|fixed)$/.test(style.position) && rect?.length === 4) {
      const [top, right, bottom, left] = rect.map((value, i) => value === 'auto' ? [0, box.width, box.height, 0][i] : length(value, i % 2 ? box.width : box.height));
      if (right <= left || bottom <= top) return true;
    }
    const clip = style.clipPath;
    const inset = /^inset\(([^)]*)\)$/.exec(clip)?.[1].split(/\s+round\s+/)[0].trim().split(/\s+/);
    if (inset?.length > 0 && inset.length <= 4) {
      const [t, r = t, b = t, l = r] = inset;
      if (length(t, box.height) + length(b, box.height) >= box.height || length(l, box.width) + length(r, box.width) >= box.width) return true;
    }
    const circle = /^circle\(([^\s)]+)/.exec(clip);
    if (circle && length(circle[1], Math.min(box.width, box.height)) === 0) return true;
    const ellipse = /^ellipse\(([^\s]+)\s+([^\s)]+)/.exec(clip);
    if (ellipse && (length(ellipse[1], box.width) === 0 || length(ellipse[2], box.height) === 0)) return true;
    const polygon = /^polygon\((.*)\)$/.exec(clip)?.[1].replace(/^(?:nonzero|evenodd),\s*/, '').split(',').map(point => {
      const [x, y] = point.trim().split(/\s+/); return [length(x, box.width), length(y, box.height)];
    });
    if (polygon?.length >= 3 && polygon.every(point => point.every(Number.isFinite))) {
      const [a] = polygon, b = polygon.find(point => point[0] !== a[0] || point[1] !== a[1]) ?? a;
      // Only collinear points prove zero area. A self-intersecting polygon can have zero signed area and still paint.
      if (polygon.every(p => Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) < 0.000001)) return true;
    }
    return false;
  };
  const visible = node => {
    if (!node || read(node, 'nodeType') !== 1) return true;
    if (hidden.has(node)) return hidden.get(node);
    const style = getComputedStyle(node);
    let yes = !read(node, 'hasAttribute')?.('hidden') && attribute(node, 'aria-hidden') !== 'true' &&
      style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility) && style.contentVisibility !== 'hidden' && visible(parent(node));
    if (yes) {
      const boxes = Array.from(read(node, 'getClientRects')?.() ?? []);
      const noBox = /^(br|wbr|col|colgroup)$/.test(tag(node)) || style.display === 'contents' ||
        style.display === 'inline' && !children(node).length && !(read(node, 'textContent') ?? '').trim();
      const geometry = noBox || boxes.some(onCanvas);
      if (!geometry || Number(style.opacity) === 0 || parseFloat(style.fontSize) === 0 || boxes.length > 0 && boxes.every(box => zeroClip(style, box))) {
        yes = false; reasons.add('visually hidden text omitted');
      }
    }
    hidden.set(node, yes); return yes;
  };
  if (!visible(el)) throw Error('Export collection is hidden');
  const integer = value => /^\d+$/.test(value ?? '') && Number(value) <= 1000000000 ? Number(value) : undefined;
  const tokens = value => (value ?? '').trim().split(/\s+/).filter(Boolean);
  const references = (node, key) => {
    const root = read(node, 'getRootNode')?.();
    return tokens(attribute(node, key)).slice(0, 32).map(id => read(root, 'getElementById')?.(id)).filter(Boolean);
  };
  const bound = node => ['aria-controls', 'for'].every(key => !attribute(node, key) ||
    tokens(attribute(node, key)).every(id => id === attribute(el, 'id')));
  const linkedLabels = new Set([...references(el, 'aria-labelledby'), ...references(el, 'aria-describedby')]);
  const tied = node => linkedLabels.has(node) || ['aria-controls', 'for'].some(key =>
    attribute(el, 'id') && tokens(attribute(node, key)).includes(attribute(el, 'id')));
  // Paint checks apply to text itself so an opaque child of a transparent container stays readable.
  const readableText = node => {
    const owner = parent(node), style = getComputedStyle(owner);
    const transparent = value => value === 'transparent' || /^rgba\([^)]*,\s*0(?:\.0*)?\)$/.test(value) || /\/\s*0(?:%|\.0*)?\s*\)$/.test(value);
    let yes = !transparent(style.color) && !transparent(style.webkitTextFillColor);
    if (yes && parseFloat(style.textIndent)) {
      const range = read(read(node, 'ownerDocument'), 'createRange')();
      Range.prototype.selectNodeContents.call(range, node);
      const boxes = Array.from(Range.prototype.getClientRects.call(range)).filter(box => box.width > 0 && box.height > 0);
      yes = boxes.length > 0 && boxes.every(onCanvas);
    }
    if (!yes) reasons.add('visually hidden text omitted');
    return yes;
  };
  // Count labels must be whole labels, outside data rows, and read only from visible text.
  const labelText = node => {
    let value = '', budget = 256, truncated = false;
    const scan = (current, depth = 0) => {
      if (--budget < 0 || depth > 16 || value.length > 160) { truncated = true; return; }
      if (read(current, 'nodeType') === 3) { if (readableText(current)) value += read(current, 'nodeValue') ?? ''; return; }
      if (read(current, 'nodeType') !== 1 || current !== node && collection(current) || !bound(current) || !visible(current) ||
          /^(script|style|input|textarea|select)$/.test(tag(current))) return;
      for (const child of Array.from(read(current, 'childNodes') ?? [])) scan(child, depth + 1);
    };
    scan(node);
    return truncated || value.length > 160 ? '' : value.trim().replace(/\s+/g, ' ');
  };
  const declaredRows = node => {
    const label = labelText(node);
    const match = /^(?:showing\s+)?\d[\d,]*(?:\s+to\s+|\s*[-–]\s*)\d[\d,]*\s+of\s+(\d[\d,]*)(?:\s+(?:entries|results|rows|items))?\.?$/i.exec(label) ??
      /^(\d[\d,]*)\s+(?:results?|rows?|entries|items)(?:\s+(?:total|found))?\.?$/i.exec(label) ??
      /^total\s*:?\s*(\d[\d,]*)\s+(?:results?|rows?|entries|items)\.?$/i.exec(label) ??
      /^total\s+(?:results?|rows?|entries|items)\s*:?\s*(\d[\d,]*)\.?$/i.exec(label);
    // Validate every numeral, including range endpoints, before removing separators.
    return match && (label.match(/\d[\d,]*/g) ?? []).every(value => /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value))
      ? integer(match[1].replaceAll(',', '')) : undefined;
  };
  const inspect = node => {
    if (attribute(node, 'aria-busy') === 'true' || role(node) === 'progressbar') reasons.add('collection contains a loading indicator');
    if (/\bnext\b/i.test(attribute(node, 'rel') ?? '')) signals.add('nearby pagination control');
    const countText = children(node).length <= 16 && /^(span|p|div|nav|a|button|ul|ol)$/.test(tag(node)) ? (read(node, 'textContent') ?? '').slice(0, 160) : '';
    if (/\bpage\s+\d+\s+(?:of|\/)\s*\d+\b/i.test((attribute(node, 'aria-label') ?? '') + ' ' + countText)) signals.add('nearby pagination page count (pages, not a row total)');
    // textContent joins adjacent list items without spaces. Read each item's label for a numeric page run.
    const pageLabels = node !== el && /^(ul|ol|div|nav|p|span)$/.test(tag(node)) ? children(node).slice(0, 16).map(child => (read(child, 'textContent') ?? '').slice(0, 160).trim()) : [];
    if (node !== el && (/^\s*\d+(?:\s+\d+){1,}(?:\s*[….]+)?\s*$/.test(countText) ||
        pageLabels.length >= 2 && pageLabels.every(label => /^\d+$|^[….]+$/.test(label)) && pageLabels.filter(label => /^\d+$/.test(label)).length >= 2))
      signals.add('nearby pagination page numbers');
    if (/^(button|a)$/.test(tag(node)) || role(node) === 'button') {
      const label = (attribute(node, 'aria-label') ?? read(node, 'textContent') ?? '').slice(0, 120).trim();
      if (/^(?:(?:go\s+to\s+)?(?:the\s+)?(?:next|previous|older|newer)(?:\s+(?:page|posts?|items?|results?))?|more(?:\s+(?:posts?|items?|results?))?|(?:load|show|view|see|read)\s+(?:\d+\s+)?(?:more|older|newer)(?:\s+(?:posts?|items?|results?))?)\s*[»«›‹→←><]*$/i.test(label) ||
          /^[»«›‹→←><]+$/.test(label)) signals.add('unopened pagination or expansion control');
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
        if (!readableText(current)) return;
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
      const control = /^(input|textarea|select)$/.test(tag(current)) || /^(textbox|combobox|searchbox|spinbutton)$/.test(role(current)) || read(current, 'isContentEditable');
      if (/^(input|textarea|select)$/.test(tag(current)) || read(current, 'isContentEditable') ||
        control && (/(?:^|\s)cc-/i.test(attribute(current, 'autocomplete') ?? '') || sensitive.test([
          attribute(current, 'type'), attribute(current, 'name'), attribute(current, 'id'), attribute(current, 'autocomplete'), attribute(current, 'aria-label'),
          attribute(current, 'placeholder'), attribute(current, 'data-placeholder'),
          ...references(current, 'aria-describedby').map(node => (read(node, 'textContent') ?? '').slice(0, 1024))].join(' ')))) {
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
    if (/^(caption|tfoot)$/.test(tag(node))) {
      const count = declaredRows(node);
      if (count !== undefined) { textTotals.push(count); return false; }
    }
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
      header = cells.length > 0 && (tag(parent(record)) === 'thead' ||
        cells.every(node => tag(node) === 'th' && attribute(node, 'scope') !== 'row' || role(node) === 'columnheader'));
      if (cells.length > limits.columns) { reasons.add('column budget reached'); cells = cells.slice(0, limits.columns); }
      if (cells.some(node => ['rowspan', 'colspan', 'aria-rowspan', 'aria-colspan'].some(key => Number(attribute(node, key)) > 1))) reasons.add('spanning cells kept as single cells');
    } else cells = [record];
    const count = integer(attribute(record, table ? 'aria-rowcount' : 'aria-setsize'));
    if (count !== undefined) totals.push(count);
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
    if (attribute(record, 'aria-setsize') === '-1' || attribute(record, 'aria-busy') === 'true') reasons.add('row total unknown or row busy');
    if (capped) break;
  }
  if (indices.some((value, i) => value < 1 || i > 0 && value !== indices[i - 1] + 1) || indices.length && indices[0] > 1 + headers) reasons.add('row index gaps or missing beginning');
  if (indices.length && indices.length !== rows.length) reasons.add('some row indices are missing');
  if (rows.some(row => row.length !== (columns.length || rows[0]?.length))) reasons.add('ragged rows have different cell counts');
  // Nearby controls are observations. Only a declaration can establish a total.
  {
    const seen = new WeakSet();
    const foreignCollection = (node, depth = 0) => {
      if (!node || node === el) return false;
      if (++nodes > 50000 || depth > 96) { reasons.add('DOM budget reached'); return true; }
      return collection(node) || branches(node).some(child => foreignCollection(child, depth + 1));
    };
    // Explicit references may live farther away than the observation neighborhood.
    const root = read(el, 'getRootNode')?.();
    const labels = Array.from(read(root, 'querySelectorAll')?.('[aria-controls],label[for]') ?? []);
    for (const node of [...linkedLabels, ...labels]) {
      if (++nodes > 50000) { reasons.add('DOM budget reached'); break; }
      if (tied(node) && bound(node) && !collection(node)) {
        const count = declaredRows(node);
        if (count !== undefined) textTotals.push(count);
      }
    }
    const nearby = (node, depth = 0, allowTotal = true) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (++nodes > 50000 || depth > 96) { reasons.add('DOM budget reached'); return; }
      if (/sentinel/i.test((attribute(node, 'class') ?? '') + ' ' + (attribute(node, 'id') ?? '')))
        signals.add('possible infinite scroll sentinel');
      if (tag(node) === 'header' || role(node) === 'banner') return;
      if (node === el || !visible(node)) return;
      inspect(node);
      if (!bound(node)) allowTotal = false;
      // Never borrow another collection's declared total or its data labels.
      if (collection(node)) {
        if (!/^(ul|ol)$/.test(tag(node)) && role(node) !== 'list') return;
        allowTotal = false;
      } else if (bound(node) && /^(span|p|div|footer|caption|output|label)$/.test(tag(node))) {
        const count = declaredRows(node);
        if (count !== undefined && !tied(node) && allowTotal) {
          observedTotals.push(count); signals.add('nearby count label is not tied to the collection');
        }
      }
      for (const child of branches(node)) nearby(child, depth + 1, allowTotal);
    };
    for (let node = el, depth = 0; node && depth < 96; node = parent(node), depth++) {
      const body = tag(node) === 'body';
      if (tag(node) === 'html') break;
      if (body) {
        const document = read(node, 'ownerDocument'), scroller = read(document, 'scrollingElement');
        const box = read(el, 'getBoundingClientRect')?.(), style = getComputedStyle(node), ownStyle = getComputedStyle(el);
        const tail = key => Math.max(0, parseFloat(style[key]) || 0) + Math.max(0, parseFloat(ownStyle[key]) || 0);
        if (box && ((read(scroller, 'scrollHeight') ?? 0) > Math.max(innerHeight, box.bottom + scrollY + tail('marginBottom') + (parseFloat(style.paddingBottom) || 0)) + 1 ||
            (read(scroller, 'scrollWidth') ?? 0) > Math.max(innerWidth, box.right + scrollX + tail('marginRight') + (parseFloat(style.paddingRight) || 0)) + 1))
          signals.add('possible infinite scroll beyond collection');
      }
      if ((read(node, 'scrollHeight') ?? 0) > (read(node, 'clientHeight') ?? 0) + 1 ||
          (read(node, 'scrollWidth') ?? 0) > (read(node, 'clientWidth') ?? 0) + 1) signals.add('scrolling collection');
      if (node !== el && bound(node) && !foreignCollection(node)) {
        const count = declaredRows(node);
        if (count !== undefined && !tied(node)) {
          observedTotals.push(count); signals.add('nearby count label is not tied to the collection');
        }
      }
      // Cross overflow wrappers. Inspect adjacent siblings at each level, never the whole document.
      const siblings = branches(parent(node)).filter(child => !/^(script|style|template)$/.test(tag(child))), index = siblings.indexOf(node);
      const neighbors = [-2, -1, 1, 2].map(offset => siblings[index + offset]).filter(Boolean);
      const allowTotal = !neighbors.some(node => foreignCollection(node));
      for (const sibling of neighbors) nearby(sibling, 0, allowTotal);
      if (body) break;
    }
  }
  // ARIA row counts include the header. Text counts describe data rows.
  // Hidden header rows still contribute to aria-rowcount, even when outside a thead.
  let hiddenHeaders = 0;
  if (table) for (const record of Array.from(read(el, 'querySelectorAll')?.('tr,[role="row"]') ?? [])) {
    if (++nodes > 50000) { reasons.add('DOM budget reached'); break; }
    if (visible(record) || read(record, 'closest')?.('table,[role="table"],[role="grid"],[role="treegrid"]') !== el) continue;
    const cells = Array.from(read(record, 'querySelectorAll')?.('td,th,[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]') ?? [])
      .filter(node => read(node, 'closest')?.('tr,[role="row"]') === record);
    if (cells.length && (tag(parent(record)) === 'thead' || cells.every(node =>
      tag(node) === 'th' && attribute(node, 'scope') !== 'row' || role(node) === 'columnheader'))) hiddenHeaders++;
  }
  if (hiddenHeaders) reasons.add('hidden header rows omitted');
  const declarations = [...totals.map(count => Math.max(0, count - headers - hiddenHeaders)), ...textTotals];
  const counts = [...declarations, ...observedTotals.filter(count => count > rows.length)];
  const expected = counts.length ? Math.max(...counts) : undefined;
  if (new Set(declarations).size > 1) reasons.add('page declares conflicting totals');
  if (!declarations.length) reasons.add('collection has no declared total');
  if (expected !== undefined && expected > rows.length) reasons.add(`${expected - rows.length} rows not rendered (virtualized or paginated collection)`);
  if (declarations.some(count => count < rows.length)) reasons.add('rendered count exceeds the declared total');
  if (indices.length && expected === undefined) reasons.add('indexed collection has no declared total');
  // Inspect zero-height feed sentinels even though their text is not readable.
  for (const node of branches(el)) if (/sentinel/i.test((attribute(node, 'class') ?? '') + ' ' + (attribute(node, 'id') ?? '')))
    signals.add('possible infinite scroll sentinel');
  if (!rows.length) reasons.add('no readable data rows');
  return { kind: table ? 'table' : 'list', columns, rows, declaredTotal: expected,
    complete: declarations.length > 0 && expected === rows.length && reasons.size === 0, reasons: [...reasons, ...signals], redacted };
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

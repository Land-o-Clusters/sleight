// Completeness describes the returned view, never the whole document or an unseen server-side collection.
export function readCompleteness({ cut, ref, omitted = 0, unknown = false, filtered = false, changesOnly = false, renderedUnknown = false, closed = false } = {}) {
  const tail = omitted > 0 ? `${omitted} rows not rendered (page-declared total)` + (unknown ? '; other row totals unknown' : '') : unknown ? 'row total unknown' : '';
  const scope = filtered ? 'filtered view' : changesOnly ? 'changes only' : renderedUnknown ? 'rendered view' : 'returned view';
  const notes = [renderedUnknown ? 'lazy/virtual rows unknown' : '', closed ? 'closed shadow roots: controls only' : ''].filter(Boolean).join('; ');
  if (cut !== undefined) return `cut at ${cut} chars; ` + (ref ? `Continue with ref="${ref}".`
    : 'shortened text exceeds the cap. Use the engine browser path for that text.') +
    (tail ? ' ' + tail : '') + (changesOnly || filtered ? ` ${scope}.` : '') + (notes ? ' ' + notes : '');
  return tail ? tail + (changesOnly || filtered ? `; ${scope}` : '') + (notes ? '; ' + notes : '')
    : `complete (${scope}${notes ? '; ' + notes : ''})`;
}

// Runs after result budgeting, so a byte-cap omission cannot leave a stale "complete" footer.
export function resultCompleteness(content, { filtered = false, failed = false } = {}) {
  const text = (content ?? []).filter(c => c?.type === 'text').map(c => c.text ?? '').join('\n');
  const native = /^(?:Window: |Browser tab: )/m.test(text);
  const footer = [...text.matchAll(/^# (?:complete \([^\n]*\)|cut at [^\n]*|\d+ rows not rendered[^\n]*|row total unknown[^\n]*)$/gm)].at(-1)?.[0];
  const changes = /^(?:sleight: (?:lines changed since (?:the|your) last full tree|no change since the last full tree)|The following is a diff from the previous accessibility tree)/m.test(text);
  if (!native && !footer && !changes) return;
  if (failed || /(?:^| \u2014 )sleight: \d+ (?:browser tree lines|tree lines|controls|static or structural lines|structural lines|sibling rows) omitted\b/m.test(text))
    return '# incomplete read; omitted or unavailable content. Read again for missing information.';
  if (filtered) return '# incomplete read (filtered engine view).';
  if (footer) return footer;
  if (changes)
    return '# complete (changes only; returned engine view; unseen rows unknown).';
  return '# complete (returned engine view; unseen rows unknown).';
}

// Reuse the native DOMSnapshot already acquired for redaction. MAIN-world getters cannot alter this accounting.
// Counts remain untrusted page declarations and grant no input authority.
export function declaredRows({ strings, documents }, { viewport } = {}) {
  let omitted = 0, unknown = false, renderedUnknown = false;
  for (const { nodes, layout, viewportWidth: fallbackWidth = viewport?.width, viewportHeight: fallbackHeight = viewport?.height, scrollOffsetX = 0, scrollOffsetY = 0 } of documents) {
    const collections = new Map();
    const scrollable = new Set(nodes.isScrollable?.index ?? []);
    for (let i = 0; i < (layout?.nodeIndex?.length ?? 0); i++)
      if (layout.styles?.[i]?.some(value => /^(?:auto|scroll|overlay)$/.test(strings[value]))) scrollable.add(layout.nodeIndex[i]);
    const boxes = new Map((layout?.nodeIndex ?? []).map((index, at) => [index, layout.bounds?.[at]]));
    const documentIndex = nodes.nodeName.findIndex(name => /^#document$/i.test(strings[name]));
    const documentBox = boxes.get(documentIndex);
    const viewportWidth = documentBox?.[2] ?? fallbackWidth, viewportHeight = documentBox?.[3] ?? fallbackHeight;
    const inScrollContainer = index => {
      for (let steps = 0; index >= 0 && steps++ < 128; index = nodes.parentIndex[index]) {
        if (/^(?:#document|HTML|BODY)$/i.test(strings[nodes.nodeName[index]])) break;
        const box = boxes.get(index);
        // Stop before the nearest viewport-sized app shell, even when it scrolls the whole page.
        if (box && viewportWidth > 0 && viewportHeight > 0 &&
            Math.abs(box[0] - scrollOffsetX) < 1 && Math.abs(box[1] - scrollOffsetY) < 1 &&
            Math.abs(box[2] - viewportWidth) < 1 && Math.abs(box[3] - viewportHeight) < 1) break;
        if (scrollable.has(index)) return true;
      }
      return false;
    };
    const rendered = layout?.nodeIndex;
    const visible = new Set(rendered);
    if (rendered) for (let i = nodes.nodeName.length - 1; i >= 0; i--)
      if (visible.has(i)) visible.add(nodes.parentIndex[i]);
    const number = value => /^\d+$/.test(value ?? '') && Number.isSafeInteger(Number(value)) && Number(value) <= 1e9 ? Number(value) : null;
    for (let i = 0; i < nodes.nodeName.length; i++) {
      const attrs = {}, raw = nodes.attributes?.[i] ?? [];
      for (let j = 0; j < raw.length; j += 2) attrs[strings[raw[j]]] = strings[raw[j + 1]];
      const role = attrs.role, total = attrs['aria-rowcount'] ?? attrs['aria-setsize'];
      if (/^(?:grid|table|treegrid|list|listbox|tree)$/.test(role) || /^(?:UL|OL|TABLE|SELECT)$/.test(strings[nodes.nodeName[i]])) {
        const ordinary = /^(?:UL|OL|TABLE|SELECT)$/.test(strings[nodes.nodeName[i]]) || role === 'list';
        collections.set(i, { total: number(total), declared: total !== undefined, unknown: total !== undefined && number(total) === null,
          renderedUnknown: !ordinary || inScrollContainer(i), positions: new Set(), count: 0 });
      }
      if (!/^(?:row|option|listitem|treeitem)$/.test(role) && !/^(?:TR|OPTION|LI)$/.test(strings[nodes.nodeName[i]])) continue;
      let parent = nodes.parentIndex[i], steps = 0;
      while (parent >= 0 && !collections.has(parent) && steps++ < 128) parent = nodes.parentIndex[parent];
      const collection = collections.get(parent);
      if (!collection) continue;
      if (attrs['aria-setsize'] !== undefined) {
        const size = number(attrs['aria-setsize']);
        if (size === null || collection.declared && collection.total !== size) collection.unknown = true;
        else collection.total = size;
        collection.declared = true;
      }
      if (rendered && !visible.has(i)) continue;
      const position = attrs['aria-rowindex'] ?? attrs['aria-posinset'];
      if (position !== undefined) {
        const n = number(position);
        if (n === null || n < 1 || collection.total !== null && n > collection.total) collection.unknown = true;
        else collection.positions.add(n);
      }
      else collection.count++;
    }
    for (const collection of collections.values()) {
      if (!collection.declared) { renderedUnknown ||= collection.renderedUnknown; continue; }
      if (collection.unknown || collection.total === null || collection.total < collection.positions.size + collection.count) unknown = true;
      else omitted += collection.total - collection.positions.size - collection.count;
    }
  }
  return { omitted, unknown, ...(renderedUnknown ? { renderedUnknown: true } : {}) };
}

// The relay passes code with strings/comments masked. Only a read result's own projection narrows its scope.
export function filteredRead(code) {
  const read = /\.\s*(?:getAXState(?:AndScreenshot)?|getState|getApp|getTab)\s*\([^()]*\)/;
  for (const match of code.matchAll(/\.\s*(?:slice|filter|substring)\s*\(/g)) {
    const before = code.slice(0, match.index);
    if (new RegExp(read.source + String.raw`\s*\)*\s*$`).test(before)) return true;
    const receiver = /([A-Za-z_$][\w$]*)\s*$/.exec(before)?.[1];
    if (!receiver) continue;
    const escaped = receiver.replace(/[$]/g, '\\$&');
    const assignments = [...before.matchAll(new RegExp(String.raw`(?<![\w$.])${escaped}\s*=\s*([^;\n]+)`, 'g'))];
    if (assignments.length && read.test(assignments.at(-1)[1])) return true;
  }
  return false;
}

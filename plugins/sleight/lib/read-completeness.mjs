// Completeness describes the returned view, never the whole document or an unseen server-side collection.
export function readCompleteness({ cut, ref, omitted = 0, unknown = false, filtered = false, changesOnly = false, renderedUnknown = false, closed = false } = {}) {
  const tail = omitted > 0 ? `${omitted} rows not rendered (page-declared total)` + (unknown ? '; other row totals unknown' : '') : unknown ? 'row total unknown' : '';
  const scope = changesOnly ? 'changes only' : filtered ? 'filtered view' : renderedUnknown ? 'rendered view' : 'returned view';
  const notes = [renderedUnknown ? 'lazy/virtual rows unknown' : '', closed ? 'closed shadow roots: controls only' : ''].filter(Boolean).join('; ');
  if (cut !== undefined) return `cut at ${cut} chars; ` + (ref ? `Continue with ref="${ref}".`
    : 'shortened text exceeds the cap. Use the engine browser path for that text.') +
    (tail ? ' ' + tail : '') + (changesOnly || filtered ? ` ${scope}.` : '') + (notes ? ' ' + notes : '');
  return tail ? tail + (changesOnly || filtered ? `; ${scope}` : '') + (notes ? '; ' + notes : '')
    : `complete (${scope}${notes ? '; ' + notes : ''})`;
}

// Runs after result budgeting, so a byte-cap omission cannot leave a stale "complete" footer.
export function resultCompleteness(content, { requested = false, filtered = false, failed = false } = {}) {
  const text = (content ?? []).filter(c => c?.type === 'text').map(c => c.text ?? '').join('\n');
  const native = /^(?:Window: |Browser tab: )/m.test(text);
  const footer = [...text.matchAll(/^# (?:complete \([^\n]*\)|cut at [^\n]*|\d+ rows not rendered[^\n]*|row total unknown[^\n]*)$/gm)].at(-1)?.[0];
  if (!requested && !native && !footer) return;
  if (failed || /(?:^| \u2014 )sleight: \d+ (?:browser tree lines|tree lines|controls|static or structural lines|structural lines|sibling rows) omitted\b/m.test(text))
    return '# incomplete read; omitted or unavailable content. Read again for missing information.';
  if (footer) return footer;
  if (/^(?:sleight: (?:lines changed since (?:the|your) last full tree|no change since the last full tree)|The following is a diff from the previous accessibility tree)/m.test(text))
    return '# complete (changes only; returned engine view; unseen rows unknown).';
  if (!native) return '# incomplete read; content unavailable.';
  return filtered ? '# incomplete read (filtered engine view).' : '# complete (returned engine view; unseen rows unknown).';
}

// Reuse the native DOMSnapshot already acquired for redaction. MAIN-world getters cannot alter this accounting.
// Counts remain untrusted page declarations and grant no input authority.
export function declaredRows({ strings, documents }) {
  let omitted = 0, unknown = false, renderedUnknown = false;
  for (const { nodes, layout } of documents) {
    const collections = new Map();
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
        collections.set(i, { total: number(total), declared: total !== undefined, unknown: total !== undefined && number(total) === null, positions: new Set(), count: 0 });
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
      if (!collection.declared) { renderedUnknown = true; continue; }
      if (collection.unknown || collection.total === null || collection.total < collection.positions.size + collection.count) unknown = true;
      else omitted += collection.total - collection.positions.size - collection.count;
    }
  }
  return { omitted, unknown, ...(renderedUnknown ? { renderedUnknown: true } : {}) };
}

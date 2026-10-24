// Completeness describes the returned view, never the whole document or an unseen server-side collection.
export function readCompleteness({ cut, ref, omitted = 0, unknown = false, filtered = false } = {}) {
  const tail = omitted > 0 ? `${omitted} rows not rendered (page-declared total)` + (unknown ? '; other row totals unknown' : '') : unknown ? 'row total unknown' : '';
  if (cut !== undefined) return `cut at ${cut} chars; Continue with ref="${ref}".` + (tail ? ' ' + tail : '');
  return tail || `complete (${filtered ? 'filtered' : 'returned'} view)`;
}

// Runs after result budgeting, so a byte-cap omission cannot leave a stale "complete" footer.
export function resultCompleteness(content, { requested = false, filtered = false, failed = false } = {}) {
  const text = (content ?? []).filter(c => c?.type === 'text').map(c => c.text ?? '').join('\n');
  const native = /^(?:Window: |Browser tab: )/m.test(text);
  const footer = [...text.matchAll(/^# (?:complete \([^\n]*\)|cut at [^\n]*|\d+ rows not rendered[^\n]*|row total unknown[^\n]*)$/gm)].at(-1)?.[0];
  if (!requested && !native && !footer) return;
  if (failed || /(?:tree lines|controls|structural lines|sibling rows) omitted|…\(\d+\)|\btruncated\b/i.test(text))
    return '# incomplete read; omitted or unavailable content. Read again for missing information.';
  if (footer) return footer;
  if (!native) return '# incomplete read; content unavailable.';
  return filtered ? '# incomplete read (filtered engine view).' : '# complete (returned engine view; unseen rows unknown).';
}

// Reuse the native DOMSnapshot already acquired for redaction. MAIN-world getters cannot alter this accounting.
// Counts remain untrusted page declarations and grant no input authority.
export function declaredRows({ strings, documents }) {
  let omitted = 0, unknown = false;
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
      if (/^(?:grid|table|treegrid|list|listbox|tree)$/.test(role)) {
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
      if (!collection.declared) continue;
      if (collection.unknown || collection.total === null || collection.total < collection.positions.size + collection.count) unknown = true;
      else omitted += collection.total - collection.positions.size - collection.count;
    }
  }
  return { omitted, unknown };
}

import { createHash } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('base64');
const hidden = text => ({ redacted: true, length: text.length });
const element = /^(\t*)(\d+) (.*)$/;
const diff = /^[+~\-] ?\t*(?:\d+ )?[a-z]/m;
const attribute = /(?:^|, | )(?<name>Selected text|Selected Text|SelectedText|Selected|Value|ID|Description|Help|URL|Secondary Actions): /g;

// Remove sensitive nodes, continuation lines and descendants before any receipt hashing.
// Unknown secure-field spellings in an upstream tree cannot be recognized here.
export function withoutSecureFields(text) {
  // Native selection is a window-level footer, not an attribute of the last menu item.
  const footer = text.indexOf('\nSelected text:');
  const selected = footer < 0 ? undefined : /^\nSelected text: ```\r?\n([\s\S]*?)\r?\n```(?:\r?\n|$)/.exec(text.slice(footer));
  if (footer >= 0) text = text.slice(0, footer);
  const kept = [];
  let secureDepth, excluded = false;
  for (const line of text.split('\n')) {
    const node = element.exec(line);
    if (node && secureDepth !== undefined && node[1].length <= secureDepth) secureDepth = undefined;
    if (node && /\b(?:secure|password|protected)\b/i.test(node[3])) {
      secureDepth ??= node[1].length; excluded = true;
    }
    if (secureDepth === undefined) kept.push(line);
  }
  // The footer carries no field identity. Any secure node makes its provenance uncertain.
  return { text: kept.join('\n'), excluded, selectionInvalid: footer >= 0 && !selected,
    ...(!excluded && selected ? { selection: { fingerprint: hash(selected[1]), display: hidden(selected[1]) } } : {}) };
}

export function fieldObservation(text, excluded, selection) {
  // A root plus diff lines is still a diff, not a complete field observation.
  if (diff.test(text) || /…\(\d+\)|sleight: (?:lines changed|no change since)/.test(text)) return undefined;
  const nodes = [], lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    const match = element.exec(line);
    if (match) nodes.push({ depth: match[1].length, body: match[3] });
    else if (nodes.length && (line.trim() || (i < lines.length - 1 && /\bValue:/.test(nodes.at(-1).body)))) nodes.at(-1).body += '\n' + line;
  }
  if (!nodes.length || nodes[0].depth !== 0 ||
      !/^(?:(?:standard|floating|system|dialog) window|window|sheet|dialog)\b/.test(nodes[0].body)) return undefined;
  const fields = [], structure = [], parents = [];
  for (const { depth, body } of nodes) {
    const marks = [...body.matchAll(attribute)];
    const attrs = new Map(marks.map((mark, i) => [mark.groups.name,
      body.slice(mark.index + mark[0].length, marks[i + 1]?.index)]));
    const prefix = body.slice(0, marks[0]?.index ?? body.length).replace(/,\s*$/, '');
    const role = /^(text entry area|text area|text field|pop up button|popup button|combo box|checkbox|check box|radio button|toggle button|row|cell|tab)(?=\W|$)/.exec(prefix)?.[1];
    // Dynamic values and state flags don't define an element's identity. Labels remain hashes.
    const identity = prefix.replace(/\([^)]*\)/g, '').trim() + '\0' + (attrs.get('Description') ?? '');
    while (parents.length && parents.at(-1).depth >= depth) parents.pop();
    const path = parents.map(parent => parent.identity).join('\0') + '\0' + identity;
    parents.push({ depth, identity });
    structure.push(hash(`${depth}\0${path}`));
    if (!role) continue;
    const properties = {};
    const add = (property, value, display = hidden(value)) => { properties[property] = { fingerprint: hash(value), display }; };
    const flags = [...prefix.matchAll(/\(([^)]*)\)/g)].map(match => match[1]).join(' ');
    if (attrs.has('Value')) {
      const value = attrs.get('Value');
      const checkbox = /^(?:checkbox|check box|radio button|toggle button)$/.test(role);
      const state = checkbox ? ({ '0': 'unchecked', '1': 'checked', '2': 'mixed', false: 'unchecked', true: 'checked', mixed: 'mixed' })[value.toLowerCase()] : undefined;
      add('value', value, state ?? hidden(value));
    } else if (/\b(?:checkable|checked)\b/.test(flags) && /^(?:checkbox|check box|radio button|toggle button)$/.test(role)) {
      const checked = /\bchecked\b/.test(flags);
      add('value', String(checked), checked ? 'checked' : 'unchecked');
    }
    const selectedText = attrs.get('Selected text') ?? attrs.get('Selected Text') ?? attrs.get('SelectedText');
    if (selectedText !== undefined) add('selected text', selectedText);
    if (attrs.has('Selected')) {
      const value = attrs.get('Selected');
      add('selected', value, ({ '0': 'not selected', '1': 'selected', false: 'not selected', true: 'selected' })[value.toLowerCase()] ?? hidden(value));
    } else if (/\b(?:selectable|selected)\b/.test(flags)) {
      const selected = /\bselected\b/.test(flags);
      add('selected', String(selected), selected ? 'selected' : 'not selected');
    }
    if (!Object.keys(properties).length) continue;
    const id = attrs.get('ID');
    fields.push({ identity: hash(role + '\0' + (id === undefined ? path : id)), identified: id !== undefined,
      field: fields.length + 1, role, properties });
  }
  if (selection) fields.push({ identity: hash('window selected text'), identified: true,
    field: fields.length + 1, role: 'window', properties: { 'selected text': selection } });
  return { fields, structure: hash(structure.join('\n')), excluded };
}

export function compareFields(before, after, trustworthy) {
  const unavailable = detail => ({ status: 'unavailable', changes: [], omitted: 0, detail });
  if (!trustworthy || !before || !after) return unavailable('Full before and after trees for the same window are required.');
  if (!before.fields.length && !after.fields.length) return unavailable('No supported nonsecure fields were observed.');
  const changes = [];
  let partial = false;
  const counts = fields => {
    const result = new Map();
    for (const field of fields) result.set(field.identity, (result.get(field.identity) ?? 0) + 1);
    return result;
  };
  const a = counts(before.fields), b = counts(after.fields), later = new Map(after.fields.map(field => [field.identity, field]));
  for (const field of before.fields) {
    const next = later.get(field.identity);
    if (a.get(field.identity) !== 1 || b.get(field.identity) !== 1 ||
        (!field.identified && before.structure !== after.structure)) { partial = true; continue; }
    for (const property of new Set([...Object.keys(field.properties), ...Object.keys(next.properties)])) {
      const old = field.properties[property], current = next.properties[property];
      if (!old || !current) { partial = true; continue; }
      if (old.fingerprint !== current.fingerprint) changes.push({ field: field.field, role: field.role, property, before: old.display, after: current.display });
    }
  }
  if (after.fields.some(field => !a.has(field.identity))) partial = true;
  const omitted = Math.max(0, changes.length - 100);
  return { status: partial || omitted ? 'partial' : 'compared', changes: changes.slice(0, 100), omitted,
    excluded: before.excluded || after.excluded,
    detail: partial ? 'Some fields were added, removed or ambiguous.' : 'Compared supported fields in full observations.' };
}

export function renderFields(fields) {
  if (fields.status === 'unavailable') return 'Field review unavailable. ' + fields.detail;
  const show = value => typeof value === 'string' ? value : `[redacted ${value.length} chars]`;
  return [fields.status === 'partial' ? 'Field review partial. ' + fields.detail : '',
    ...fields.changes.map(field => `${field.role} ${field.field}, ${field.property}: ${show(field.before)} -> ${show(field.after)}`),
    fields.omitted ? `${fields.omitted} field changes omitted.` : '',
    fields.excluded ? 'Secure fields excluded.' : '',
    !fields.changes.length && !fields.omitted ? 'No supported field changes observed.' : ''].filter(Boolean).join('\n');
}

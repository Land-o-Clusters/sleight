// Runtime-only display projection. The numbered tree remains the sole source
// for guards and delivered-number admission. Only display hashes are retained.
import { createHash } from 'node:crypto';
export const DOCUMENT_READ_LIMIT = 4000;
export const DOCUMENT_UNCHANGED = 'struct =';

function displaySections(rows) {
  let omitted = 0, at = 0;
  const rendered = rows.map(row => {
    // Carry the helper's source omission count through the final indentation
    // cap, rather than printing two independent truncation suffixes.
    const match = /\n\(…(\d+) more\)$/.exec(row.text);
    let plain = row.text;
    if (match) {
      const count = Number(match[1]);
      if (!Number.isSafeInteger(count) || !Number.isSafeInteger(omitted + count)) throw Error('DRIVER_PROTOCOL');
      omitted += count; plain = plain.slice(0, match.index);
    }
    const text = plain.split('\n').map(line => row.indent + line).join('\n');
    const value = { ...row, text, start: at, end: at + text.length };
    at = value.end + 1; return value;
  });
  const full = rendered.map(row => row.text).join('\n'), total = full.length + omitted;
  if (total <= DOCUMENT_READ_LIMIT) return new Map(rendered.map(row => [row.element, row.text]));
  let keep = Math.min(full.length, DOCUMENT_READ_LIMIT - 32), prefix, suffix, last;
  for (let i = 0; i < 8; i++) {
    prefix = full.slice(0, keep).replace(/\n+$/, '');
    if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
    last = rendered.findLast(row => row.start < prefix.length) ?? rendered[0];
    suffix = `\n${last.indent}(…${total - prefix.length} more)`;
    const next = Math.min(full.length, DOCUMENT_READ_LIMIT - suffix.length);
    if (next === keep) break;
    keep = next;
  }
  const result = new Map();
  for (const row of rendered) if (row.start < prefix.length)
    result.set(row.element, prefix.slice(row.start, row.end));
  result.set(last.element, (result.get(last.element) ?? '') + suffix);
  return result;
}

export function documentReadText(result, { label } = {}) {
  const tree = result?.text;
  if (typeof tree !== 'string') throw Error('DRIVER_PROTOCOL');
  const document = result.document;
  if (document === undefined) return '';
  if (document?.version !== 1 || !Array.isArray(document.sections) || document.sections.length > 10000 ||
      typeof document.needsPixels !== 'boolean' || typeof document.protected !== 'boolean') throw Error('DRIVER_PROTOCOL');
  const sections = new Map();
  let size = 0;
  for (const section of document.sections) {
    if (!Number.isSafeInteger(section?.element) || section.element < 0 || typeof section.text !== 'string' ||
        sections.has(section.element)) throw Error('DRIVER_PROTOCOL');
    size += section.text.length + (sections.size ? 1 : 0);
    if (size > DOCUMENT_READ_LIMIT) throw Error('DRIVER_PROTOCOL');
    // Native quoting makes provider controls inert. Reject a malformed helper
    // before a document can masquerade as another numbered tree or guard mark.
    if (/[\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u2028\u2029]/.test(section.text) ||
        section.text.split('\n').some(line => /^\s*\d+\s|^Window:|^The focused UI element|^\[sleight:/.test(line))) throw Error('DRIVER_PROTOCOL');
    sections.set(section.element, section.text);
  }
  const found = new Set(), rows = [], lines = tree.split('\n');
  const headingLevels = new Map();
  for (const line of lines) {
    const match = /^\t*(\d+) heading (.*)$/.exec(line);
    if (!match) continue;
    const fields = match[2].split(/, (?=(?:Description|Help|Value|Details|Placeholder|ID|URL|Selected text|Secondary Actions): )/);
    // Page text can sit in the title or in any later field, so a Value anywhere else makes
    // the level ambiguous. Only a line with exactly one Value lets the supplement drop its heading.
    const values = fields.slice(1).filter(field => field.startsWith('Value: ')).map(field => field.slice(7));
    if (values.length === 1 && /^[1-6]$/.test(values[0])) headingLevels.set(Number(match[1]), Number(values[0]));
  }
  for (const line of lines) {
    const match = /^(\t*)(\d+) /.exec(line), number = Number(match?.[2]);
    if (!match || !sections.has(number)) continue;
    found.add(number);
    const extra = sections.get(number).split('\n').filter(line => {
      const heading = /^element (\d+) heading H([1-6])$/.exec(line);
      return !heading || headingLevels.get(Number(heading[1])) !== Number(heading[2]);
    }).join('\n');
    if (extra) rows.push({ element: number, indent: '\t', text: `document element ${number}\n${extra}` });
  }
  if (found.size !== sections.size) throw Error('DRIVER_PROTOCOL');
  if (label && rows.length) rows.unshift({ element: null, indent: '', text: label + ':' });
  return [...displaySections(rows).values()].join('\n');
}

// One instance per parent session. Prepare after guards and caps, then commit
// only from the final transport's successful write callback.
// Retain at most 16 hashes, with no document strings or drag-binding data.
export function createDocumentDisplay() {
  const seen = new Map();
  let generation = 0;
  function prepare(result, baseline = seen, touched) {
    const preparedIn = generation;
    const block = documentReadText(result);
    const window = result.window;
    const key = JSON.stringify([window.windowId, window.pid, window.processStart, window.bundleId]);
    const digest = createHash('sha256').update(block).digest('hex');
    const complete = result.truncated !== true && block !== '';
    return {
      text: complete && baseline.get(key) === digest ? DOCUMENT_UNCHANGED : block,
      commit() {
        if (generation !== preparedIn) return;
        touched?.delete(key); touched?.add(key);
        baseline.delete(key);
        if (complete) baseline.set(key, digest);
        if (baseline.size > 16) baseline.delete(baseline.keys().next().value);
      },
    };
  }
  return {
    clear() { generation++; seen.clear(); },
    prepare,
    begin() {
      const preparedIn = generation, scratch = new Map(seen), touched = new Set();
      return {
        prepare(result) {
          const supplement = prepare(result, scratch, touched);
          supplement.commit();
          return supplement;
        },
        commit() {
          if (generation !== preparedIn) return;
          for (const key of touched) {
            seen.delete(key);
            if (scratch.has(key)) seen.set(key, scratch.get(key));
            if (seen.size > 16) seen.delete(seen.keys().next().value);
          }
        },
      };
    },
  };
}

// Call only at the final output boundary. Retain every ordinary text item,
// removing just the additional structured blocks from delivery bookkeeping.
export function documentDeliveryContent(content, observations) {
  const supplements = observations.filter(row => typeof row.text === 'string').map(documentReadText).filter(Boolean);
  return content.flatMap(item => {
    if (item.type !== 'text') return [];
    let text = item.text, matched = false;
    for (const supplement of supplements) if (text.includes(supplement)) {
      text = text.replaceAll(supplement, ''); matched = true;
    }
    return matched && !text.trim() ? [] : [{ ...item, text }];
  });
}

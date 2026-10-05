import { homedir } from 'node:os';

// Chess puts account names in game titles. Replace every copy, including AX labels.
export function sanitizeHelperEvidence(value, home = homedir()) {
  const titles = new Set();
  function collect(item) {
    if (typeof item === 'string') {
      for (const match of item.matchAll(/^Window: ("(?:[^"\\]|\\.)*"), App: Chess\.?\r?$/gm)) {
        titles.add(JSON.parse(match[1]));
      }
    } else if (item && typeof item === 'object') {
      for (const child of Object.values(item)) collect(child);
    }
  }
  collect(value);
  function scrub(item) {
    if (typeof item === 'string') {
      for (const title of titles) {
        item = item.replaceAll(JSON.stringify(title).slice(1, -1), '[Chess window]')
          .replaceAll(title, '[Chess window]');
      }
      return item.replaceAll(home, '~');
    }
    if (Array.isArray(item)) return item.map(scrub);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, scrub(child)]));
    return item;
  }
  return JSON.stringify(scrub(value), null, 2);
}

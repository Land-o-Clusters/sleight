import { sanitizeHelperEvidence } from './helper-evidence.mjs';

export function reliabilityEvidence(value, titles = [], home) {
  const variants = new Set();
  for (let title of titles) {
    if (typeof title !== 'string' || !title.trim()) continue;
    for (let depth = 0; depth < 8; depth++) {
      variants.add(title);
      title = JSON.stringify(title).slice(1, -1);
    }
  }
  const scrub = item => {
    if (typeof item === 'string') {
      for (const title of variants) item = item.replaceAll(title, '[Chess window]');
      return item;
    }
    if (Array.isArray(item)) return item.map(scrub);
    if (item && typeof item === 'object') {
      if (item.type === 'image') return { type: 'image', omitted: true };
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, scrub(child)]));
    }
    return item;
  };
  return sanitizeHelperEvidence(scrub(value), home);
}

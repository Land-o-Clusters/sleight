import { PASS_THROUGH } from '../platform/darwin-ancestry.mjs';

// Only direct, normalized system paths qualify. Never resolve an alias or `..`.

export function knownNonAppAncestorPath(path) {
  const match = typeof path === 'string' && /^\/(?:usr\/)?s?bin\/([a-z]+)$/u.exec(path);
  return Boolean(match && PASS_THROUGH.has(match[1]));
}

// Paths come from the kernel's mapped executable, never argv or model text.
// Keep malformed paths unknown; normalization must not hide an app boundary.
export function classifyAncestorPath(path, readBundleId) {
  if (typeof path !== 'string' || path.length > 16384 || !path.startsWith('/') ||
      /[\u0000-\u001f\u007f]/u.test(path) || path.slice(1).split('/').some(part => !part || part === '.' || part === '..')) return null;
  if (knownNonAppAncestorPath(path)) return { kind: 'non-app' };
  const bundle = /^(.+?\.app)\/Contents\//iu.exec(path)?.[1];
  if (!bundle) return { kind: 'non-app' };
  try {
    const id = readBundleId?.(`${bundle}/Contents/Info.plist`);
    return typeof id === 'string' && id.trim() && id.length <= 4096 ? { bundleId: id.trim() } : null;
  } catch { return null; }
}

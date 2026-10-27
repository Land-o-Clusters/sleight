// Offline release agreement. This module reads files only, with no host probes or Git commands.
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReleaseVersion, readPluginVersion } from '../plugins/sleight/lib/version.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const required = [
  '.agents/plugins/marketplace.json',
  '.claude-plugin/marketplace.json',
  '.cursor-plugin/marketplace.json',
  'plugins/sleight/.claude-plugin/plugin.json',
  'plugins/sleight/.codex-plugin/plugin.json',
  'plugins/sleight/.cursor-plugin/plugin.json',
];
const excluded = new Set(['.git', 'node_modules', 'vendor', 'tests', 'bench', '.vale']);
const manifestPath = /(?:^|\/)(?:\.(?:claude|codex|cursor)-plugin\/(?:plugin|marketplace)\.json|\.agents\/plugins\/marketplace\.json)$/;
const productionDirectoryPath = /(?:^|\/)(?:\.(?:claude|codex|cursor)-plugin|\.agents|plugins(?:\/[^/]+)?)$/;

function discover(root, errors) {
  const paths = new Set(required);
  const walk = directory => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      // Top-level examples/ holds sample marketplaces with their own versions, not sleight's release.
      if (path === 'examples') continue;
      // Refuse production boundaries without following targets, including broken links and cycles.
      if (entry.isSymbolicLink() && productionDirectoryPath.test(path)) {
        errors.push(`${path}: symlink at a production manifest directory`);
      }
      else if (entry.isDirectory()) walk(path);
      else if ((entry.isFile() || entry.isSymbolicLink()) && manifestPath.test(path)) paths.add(path);
    }
  };
  walk('');
  return [...paths].sort();
}

function newestRelease(text) {
  // Skip Unreleased and prose sections, but never skip a malformed numeric release heading.
  const heading = [...text.matchAll(/^##[ \t]+(.+)$/gm)].map(match => match[1].trim())
    .find(value => /^\[?v?\d/.test(value));
  if (!heading) return null;
  const token = /^(?:\[([^\]]+)\]|([^\s]+))(?:\s|$)/.exec(heading);
  const version = token?.[1] ?? token?.[2];
  return isReleaseVersion(version) ? version : null;
}

/**
 * Synchronous, read-only inspection for release preflight. expectedVersion defaults to the first
 * CHANGELOG release heading. Optional tag must be exactly v<version>; no Git ref is resolved.
 * Returns { ok, version, changelogVersion, doctorVersion, manifests, versions, errors }.
 */
export function inspectReleaseVersion({ root = repository, expectedVersion, tag } = {}) {
  root = resolve(root);
  const errors = [], versions = [];
  const read = path => {
    try {
      const file = join(root, path);
      const target = relative(realpathSync(root), realpathSync(file));
      if (!lstatSync(file).isFile() || target === '..' || target.startsWith(`..${sep}`) || isAbsolute(target)) throw Error('Nonlocal input');
      return readFileSync(file, 'utf8');
    }
    catch { errors.push(`${path}: cannot read release input`); return null; }
  };
  const json = path => {
    const text = read(path);
    if (text === null) return null;
    try {
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path}: expected a manifest object`); return null;
      }
      return value;
    }
    catch { errors.push(`${path}: invalid JSON`); return null; }
  };
  const changelog = read('CHANGELOG.md');
  const changelogVersion = changelog === null ? null : newestRelease(changelog);
  if (!changelogVersion) errors.push('CHANGELOG.md: no valid newest release heading');
  const version = expectedVersion === undefined ? changelogVersion : expectedVersion;
  if (!isReleaseVersion(version)) errors.push('expectedVersion: a valid release version is required');
  const check = (path, field, found) => {
    versions.push({ path, field, version: found ?? null });
    if (!isReleaseVersion(found)) errors.push(`${path} ${field}: missing or invalid release version`);
    else if (isReleaseVersion(version) && found !== version) errors.push(`${path} ${field}: ${found}, expected ${version}`);
  };
  if (changelogVersion && isReleaseVersion(version) && changelogVersion !== version) {
    errors.push(`CHANGELOG.md: newest release ${changelogVersion}, expected ${version}`);
  }
  if (tag !== undefined && (!isReleaseVersion(version) || tag !== `v${version}`)) errors.push(`tag: expected v${version}`);

  let manifests = [];
  try { manifests = discover(root, errors); }
  catch { errors.push('manifests: cannot discover release manifests'); }
  for (const path of manifests) {
    const manifest = json(path);
    if (!manifest) continue;
    if (path.endsWith('/plugin.json')) { check(path, 'version', manifest.version); continue; }
    for (const [field, found] of [['version', manifest.version], ['metadata.version', manifest.metadata?.version]]) {
      if (found !== undefined) check(path, field, found);
    }
    if (!Array.isArray(manifest.plugins) || !manifest.plugins.length) {
      errors.push(`${path}: no marketplace plugins`); continue;
    }
    const host = path.includes('.agents/') || path.includes('.codex-plugin/') ? 'codex'
      : path.includes('.cursor-plugin/') ? 'cursor' : 'claude';
    for (const [index, entry] of manifest.plugins.entries()) {
      const field = `plugins[${index}]`;
      // Codex's catalog schema has no entry version; it reads the local plugin manifest.
      if (host !== 'codex' || entry?.version !== undefined) check(path, `${field}.version`, entry?.version);
      const source = host === 'codex' ? entry?.source?.source === 'local' && entry.source.path : entry?.source;
      if (typeof source !== 'string' || !source || isAbsolute(source)) {
        errors.push(`${path} ${field}.source: expected a local relative plugin path`); continue;
      }
      const target = relative(root, resolve(root, source));
      if (!target || target === '..' || target.startsWith(`..${sep}`) || isAbsolute(target)) {
        errors.push(`${path} ${field}.source: plugin path leaves the repository`); continue;
      }
      const sourcePath = `${target.split(sep).join('/')}/.${host}-plugin/plugin.json`;
      const sourceManifest = json(sourcePath);
      if (!sourceManifest) { errors.push(`${path} ${field}.source: cannot read ${sourcePath}`); continue; }
      if (sourceManifest.name !== entry?.name) errors.push(`${path} ${field}.source: plugin name disagrees with ${sourcePath}`);
      if (host === 'codex') check(path, `${field}.source (${sourcePath})`, sourceManifest.version);
      else if (sourceManifest.version !== entry?.version) errors.push(`${path} ${field}.version: disagrees with ${sourcePath}`);
    }
  }
  let doctorVersion = null;
  try { doctorVersion = readPluginVersion({ pluginRoot: join(root, 'plugins/sleight') }); }
  catch { errors.push('doctor: cannot read a valid plugin version'); }
  if (doctorVersion && isReleaseVersion(version) && doctorVersion !== version) errors.push(`doctor: ${doctorVersion}, expected ${version}`);
  return { ok: errors.length === 0, version, changelogVersion, doctorVersion, manifests, versions, errors };
}

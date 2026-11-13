// RT8 must verify bundleId and executableName against the running app's code
// signature (including team identity), and supply its complete trusted ancestry.
// Never pass REPL arguments as policy facts or as the user-setting argument.
// This module reads bundled policy only; it grants no approval or settings writes.
import { readFileSync } from 'node:fs';

const read = name => JSON.parse(readFileSync(new URL(`./app-policy/${name}.json`, import.meta.url), 'utf8'));
const categories = read('categories'), rules = read('rules');
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
// Public build/Store/cask identities, verified in FT1. Keep every heuristic below
// as a fallback for other versions, helpers and repackaged apps.
const bundles = new Map([
  ...read('bundles').apps.map(app => [normalize(app.bundleId), app.category]),
  ['com.1password.1password', 'password-managers'],
  ['com.bitwarden.desktop', 'password-managers'],
  ['com.dashlane.dashlanephonefinal', 'password-managers'],
  ['com.lastpass.lastpassforsafari', 'password-managers'],
  ['org.keepassxc.keepassxc', 'password-managers'],
  ['in.sinew.enpass-desktop', 'password-managers'],
  ['me.proton.pass.electron', 'password-managers'],
  ['dev.warp.warp-stable', 'terminals'],
  ['com.github.wez.wezterm', 'terminals'],
  ['net.kovidgoyal.kitty', 'terminals'],
  ['org.alacritty', 'terminals'],
  ['co.zeit.hyper', 'terminals'],
  ['org.tabby', 'terminals'],
]);
const safeMethods = new Set([...rules.readMethods, ...rules.pointerMethods]);
const keyInput = new Set(rules.keyInputMethods);
const confusables = new Map(Object.entries(rules.titleConfusables)
  .flatMap(([latin, variants]) => [...variants].map(character => [character, latin])));
const skeleton = value => [...value.normalize('NFKD').toLowerCase()
  .replace(/[\p{M}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')]
  .map(character => confusables.get(character) ?? character).join('');
export { skeleton as appPolicySkeleton };
const identityKey = value => skeleton(value).replace(/[^\p{L}\p{N}]/gu, '');
// Keep ambiguous l glyphs as ɫ until matching, so each can read as i or l.
// Plain l in a title stays l, including in ordinary Vietnamese document titles.
const settingsTitleKey = value => identityKey(value.toLowerCase().replace(/[łƚƛɫɬɭʟⅼ]/gu, 'ɫ'));
// Character classes cover every word-side i/l subset without folding the title.
// Short words keep the existing rule: caidat -> caldat would match medicaldata.
const settingsWords = rules.settingsTitleWords.map(identityKey)
  .map(word => new RegExp(word.replace(/[il]/gu, letter =>
    [...word].length >= 7 ? '[ilɫ]' : letter === 'l' ? '[liɫ]' : '[iɫ]'), 'u'));
const terminalSettingsTitle = new RegExp(rules.terminalSettingsTitlePattern, 'i');
const settingsIdentifier = new RegExp(rules.settingsIdentifierPattern, 'i');
const invalid = cause => ({ allow: false, category: null, code: 'APP_POLICY_INVALID_METADATA', cause,
  sentence: null, cardRisk: null, overridden: false });

function decision(category, allow = false, overrideEligible = false) {
  if (!category) return { allow: true, category: null, code: null, sentence: null, cardRisk: null, overridden: false };
  const row = categories[category];
  const sentence = overrideEligible ? (row.overrideSentence ?? row.sentence) : row.sentence;
  return { allow, category, code: allow ? null : row.code, sentence: allow ? null : sentence,
    cardRisk: row.cardRisk, overridden: allow && overrideEligible };
}

function shapeCategories(bundleId, executableName) {
  // Match components and executable basenames conservatively, including helper
  // suffixes and separators. A utilities/developer-tools LS category is no grant.
  const identities = [identityKey(bundleId), identityKey(executableName.split(/[\\/]/u).at(-1))];
  return Object.entries(rules.identityShapes).filter(([, shapes]) =>
    identities.some(identity => shapes.some(shape => identity.includes(shape)))).map(([category]) => category);
}

function exactCategories(bundleId, executableName) {
  const executable = normalize(executableName.split(/[\\/]/u).at(-1));
  return Object.entries(rules.exactIdentities).filter(([, identities]) =>
    identities.bundleIds.includes(bundleId) ||
    identities.helperBundlePrefixes?.some(prefix => bundleId === prefix || bundleId.startsWith(`${prefix}.`)) ||
    identities.executableNames.some(name => executable === name || executable.startsWith(`${name}-`) ||
      executable === `${name} helper` || executable.startsWith(`${name} helper `) ||
      executable.startsWith(`${name} helper(`)))
    .map(([category]) => category);
}

/**
 * RT8 repeats this at acquisition and before input. Metadata is trusted runtime
 * evidence, never model text. Malformed metadata returns a refusal with a cause.
 * Only { kind: 'non-app' } describes a known non-app ancestor; unavailable
 * ancestry is null/undefined and refuses. Optional executablePath is the trusted
 * full binary path, required for a bare or relative dotted-version name (optional v). Without it,
 * executableName may itself contain the full path. Optional windowSubrole/windowIdentifier
 * are AX strings when exposed; an unavailable optional attribute is omitted.
 * secureInput is a fresh DriverSession public-API sample. Missing/malformed flags
 * refuse input. focusedSecureField comes from the current leased window's tree.
 * allowForbiddenTargets is read freshly from the user-only setting, never cached.
 * The helper must also repeat secure-input checking immediately before each post
 * (DriverFocusBelief.guardInput); a JS decision cannot close the sampling race.
 * An allow still requires RT8's identity, approval and lease checks.
 */
export function evaluateAppPolicy(metadata = {}, settings = {}) {
  // Runtime lookup failures, including throwing accessors, never escape as an allow.
  try { return evaluate(metadata, settings); }
  catch { return invalid('metadata-read'); }
}

function evaluate(metadata, settings) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return invalid('metadata');
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return invalid('settings');
  const { bundleId, executableName, executablePath, processAncestry, windowTitle, operation,
    secureInput, focusedSecureField, windowSubrole = '', windowIdentifier = '' } = metadata;
  const { allowForbiddenTargets = false } = settings;
  const id = normalize(bundleId);
  if (!id) return invalid('bundleId');
  if (!Array.isArray(processAncestry) || !processAncestry.length) return invalid('processAncestry');
  if (typeof windowTitle !== 'string') return invalid('windowTitle');
  if (typeof executableName !== 'string' || !identityKey(executableName.split(/[\\/]/u).at(-1)))
    return invalid('executableName');
  if (executablePath !== undefined && (typeof executablePath !== 'string' || !executablePath.trim()))
    return invalid('executablePath');
  if (executablePath === undefined && !executableName.trim().startsWith('/') &&
      /^v?\d+(?:\.\d+)+$/u.test(normalize(executableName.split(/[\\/]/u).at(-1))))
    return invalid('executablePath');
  if (typeof windowSubrole !== 'string') return invalid('windowSubrole');
  if (typeof windowIdentifier !== 'string') return invalid('windowIdentifier');
  if (operation !== undefined && typeof operation !== 'string') return invalid('operation');
  for (const [index, process] of processAncestry.entries()) {
    if (process && typeof process === 'object' && !Array.isArray(process) &&
        process.kind === 'non-app' && Object.keys(process).length === 1) continue;
    if (!process || typeof process !== 'object' || Array.isArray(process) ||
        process.kind !== undefined || typeof process.bundleId !== 'string' || !normalize(process.bundleId)) {
      return invalid(`processAncestry[${index}]`);
    }
  }
  const ancestor = processAncestry.some(process => normalize(process?.bundleId) === id);
  const openai = rules.openaiBundlePrefixes.some(prefix => id.startsWith(prefix));
  const host = rules.agentHostBundlePrefixes.some(prefix => id === prefix || id.startsWith(`${prefix}.`));
  const matches = new Set([bundles.get(id), ...shapeCategories(id, executableName),
    ...exactCategories(id, executableName), (openai || host ||
      [executableName, executablePath ?? ''].some(path =>
        /\/claude\/versions\/[^/]+$/iu.test(path.replace(/\\/gu, '/')))) && 'agent-hosts']);
  // A conflicting identity cannot turn a password/system/host refusal into an
  // overridable terminal refusal. Exact protected categories outrank heuristics.
  const category = rules.categoryPriority.find(name => matches.has(name)) ?? null;
  const terminal = category === 'terminals';
  const restricted = category !== null || ancestor;
  const title = skeleton(windowTitle).trim();
  const titleKey = settingsTitleKey(windowTitle);
  const settingsIdentity = category === 'settings-windows' || rules.settingsWindowSubroles.includes(windowSubrole) ||
    settingsIdentifier.test(skeleton(windowIdentifier));
  if (settingsIdentity || (restricted && (settingsWords.some(word => word.test(titleKey)) ||
    (terminal && terminalSettingsTitle.test(title))))) return decision('settings-windows');

  // Unknown and missing operations are input, never an exemption from a guard.
  if (!safeMethods.has(operation)) {
    if (typeof secureInput !== 'boolean' || (secureInput && (keyInput.has(operation) ||
        !rules.semanticWriteMethods.includes(operation)))) return decision('secure-input');
    if (focusedSecureField !== false) return decision('secure-field');
  }
  if (ancestor) return decision(category ?? 'agent-hosts');
  const overrideEligible = terminal || (openai && category === 'agent-hosts' && !host);
  if (allowForbiddenTargets === true && overrideEligible) return decision(category, true, true);
  return decision(category, false, overrideEligible);
}

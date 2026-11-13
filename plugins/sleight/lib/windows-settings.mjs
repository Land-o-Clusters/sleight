// Windows CLI only. Settings are preferences, never a debugger grant or a peer receipt.
import { validWindowsHand } from './windows-settings-data.mjs';
import { getPlatform } from './platform/index.mjs';
import { createWindowsSettingsStore } from './platform/win32-files.mjs';
import { settingsCommand, settingsRefusalAsync } from './person-gate.mjs';
import { highStakesChange, confirmationRefusal, helperConfirm } from './person-confirm.mjs';
import { CAPTURE_MODES, handSetting, handStatusLines } from './hand/settings.mjs';
import { BUNDLE_ID, NAME, siteOrigin, sameBlock, sameListed, coveringBlock } from './permissions.mjs';
import { PreapprovedApps, cleanPreapproved } from './preapproved.mjs';
import { createWindowsTurboDiscovery } from './direct-browser/windows-platform.mjs';

const families = new Set(['hand', 'cursor', 'turbo', 'permissions']);
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const invalid = () => { throw Error('WINDOWS_SETTING_INVALID'); };
export const isWindowsSettingsCommand = args => families.has(args[0]);
// Exact arities only. Unknown forms cannot acquire an exemption when a writer is added later.
export function windowsSettingsExempt(args) {
  const [family, op, value] = args;
  return !!(family === 'hand' && args.length === 2 && op === 'status' ||
    family === 'cursor' && args.length === 2 && ['status', 'list'].includes(op) ||
    family === 'turbo' && args.length === 2 && op === 'status' ||
    family === 'permissions' && (args.length === 1 || args.length === 2 && ['list', 'memory'].includes(op) ||
      args.length === 3 && op === 'memory' && value === 'list'));
}

export async function windowsSettingsRefusal(args, { adapter = getPlatform('win32'), gate = settingsRefusalAsync,
  confirmation = confirmationRefusal, confirm = helperConfirm, notice = text => process.stderr.write(text) } = {}) {
  if (windowsSettingsExempt(args)) return;
  // The diagnostic rewrites a future executable, so use the generic high-stakes settings key.
  const registration = args[0] === 'register';
  const label = text => registration ? text.replaceAll('permissions register', 'register') : text;
  const normalized = registration ? ['permissions', 'register'] : args;
  const high = highStakesChange(normalized), freshMs = high ? 10000 : 0;
  try {
    const refusal = await gate(normalized, { platform: 'win32', freshMs });
    if (refusal) return label(refusal);
    if (!high) return;
    const result = await confirmation(normalized, { platform: 'win32', notice: text => notice(label(text)), presence: () => adapter.person.presence(),
      confirm: (found, options) => confirm(found, { ...options, platform: 'win32', notice,
        prepare: () => adapter.person.prepareConfirm({ platform: 'win32', notice }) }) });
    return result && label(result);
  } catch { return `sleight: ${registration ? 'register' : settingsCommand(normalized) ?? args[0]} could not verify the person, so nothing changed.`; }
}

export { validWindowsHand } from './windows-settings-data.mjs';
export function validWindowsPermissions(value = { version: 1, apps: [], sites: [] }) {
  const origins = list => Array.isArray(list) && list.length <= 256 && list.every(site => siteOrigin(site) === site) && new Set(list).size === list.length;
  if (!object(value, ['version', 'apps', 'sites', 'only']) || value.version !== 1 || !Array.isArray(value.apps) || value.apps.length > 256 ||
      !origins(value.sites) || value.only !== undefined && (!origins(value.only) || !value.only.length) ||
      !value.apps.every(app => object(app, ['id', 'name', 'aliases']) && typeof app.id === 'string' && app.id.length <= 255 && BUNDLE_ID.test(app.id) &&
        (app.name === undefined || NAME(app.name)) && (app.aliases === undefined || Array.isArray(app.aliases) && app.aliases.length > 0 && app.aliases.length <= 4 && app.aliases.every(NAME)))) invalid();
  return structuredClone(value);
}
const validTurbo = value => {
  if (value === undefined) return { version: 1, enabled: false };
  if (!object(value, ['version', 'enabled', 'browser']) || value.version !== 1 || typeof value.enabled !== 'boolean' ||
      value.browser !== undefined && !['chrome', 'edge', 'brave'].includes(value.browser)) invalid();
  return value;
};
const usage = family => `usage: sleight-mcp ${family} ${family === 'hand' ? 'on|off|status|capture hidden|visible'
  : family === 'cursor' ? 'style ring|seam | status'
  : family === 'turbo' ? 'on [--browser chrome|edge|brave] | off | status'
  : '[list] | block|unblock <app bundle id|origin> | revoke <app|turbo|all|origin> | sites only <origin...> | sites all | repair [--discard]'}\n`;

export async function windowsSettingsCommand(args, { platform = process.platform, adapter = getPlatform('win32'), store,
  out = text => process.stdout.write(text), error = text => process.stderr.write(text + '\n'),
  refuse = windowsSettingsRefusal, gate, confirmation, confirm, notice, env = process.env,
  built = async () => (await import('./direct-browser/windows-host.mjs')).windowsHandHostBuilt({ platform: 'win32', cacheRoot: adapter.join(adapter.paths().cache, 'cursor-host') }),
  discovery } = {}) {
  if (platform !== 'win32' || !isWindowsSettingsCommand(args)) return 1;
  const [family, op, ...rest] = args;
  try {
    // No store read, discovery, compiler or writer precedes the gate for a non-exempt form.
    const refusal = await refuse(args, { adapter, gate, confirmation, confirm, notice });
    if (refusal) { error(refusal); return 3; }
    store ??= createWindowsSettingsStore({ adapter });
    const writeHand = (change, replaceUnsafe = false) => {
      let before;
      try { before = validWindowsHand(store.read('hand.json')); }
      catch (error) { if (!replaceUnsafe) throw error; before = { version: 1, enabled: false }; }
      const after = validWindowsHand({ ...before, ...change });
      store.write('hand.json', after, { replaceUnsafe }); return after;
    };
    const hand = () => validWindowsHand(store.read('hand.json'));
      if (family === 'hand' || family === 'cursor') {
      if (op === 'status' && !rest.length) {
        let raw, value, unsafe = false;
        try { raw = store.read('hand.json'); value = validWindowsHand(raw); } catch { unsafe = true; }
        const setting = handSetting({ env, platform: 'win32', path: 'hand.json',
          read: () => unsafe ? { state: 'unsafe' } : raw === undefined ? { state: 'absent' } : { ...value, state: value.enabled ? 'on' : 'off' } });
        if (unsafe) out(`hand.json is unsafe or unreadable: ${adapter.join(adapter.paths().settings, 'hand.json')}. Run hand on or hand off to replace a user-owned regular file.\n`);
        const enabled = setting.enabled;
        setting.style ??= 'ring';
        if (family === 'hand') out(handStatusLines(setting, await built()).join('\n') + '\n');
        else out([`hand      ${enabled ? 'on' : setting.reason === 'env' ? 'off (SLEIGHT_HAND=0)' : 'off'}`,
          `style     ${setting.style}${setting.styleReason === 'env' ? ' (SLEIGHT_CURSOR_STYLE)' : setting.styleReason === 'env-invalid' ? ' (invalid SLEIGHT_CURSOR_STYLE)' : ''}`,
          `character ${setting.character ?? 'none'}`, `stream    ${setting.stream ? 'on' : 'off'}`, `labels    ${setting.labels ?? 'off'}`,
          `host      ${await built() ? 'compiled' : 'not compiled'}`].join('\n') + '\n');
        return 0;
      }
      if (family === 'hand' && ['on', 'off'].includes(op) && !rest.length) {
        writeHand({ enabled: op === 'on' }, true);
        out(op === 'on' ? 'The ghost hand is on. Start a new sleight session if it started with the hand off.\n'
          : 'The ghost hand is off. Running sessions hide it at once. sleight-mcp hand on turns it back on.\n');
        if (op === 'off' && env.SLEIGHT_HAND === '1') out('SLEIGHT_HAND=1 in this environment still keeps it on for servers started from here.\n');
        if (op === 'on' && env.SLEIGHT_HAND === '0') out('SLEIGHT_HAND=0 in this environment still keeps it off for servers started from here.\n');
        return 0;
      }
      if (family === 'hand' && op === 'capture' && rest.length === 1 && CAPTURE_MODES.includes(rest[0])) {
        writeHand({ capture: rest[0] });
        out(rest[0] === 'visible' ? 'Your screenshots and screen recordings show the ghost hand from the next action.\n'
          : 'Screenshots and screen recordings leave the ghost hand out from the next action.\n');
        if (env.SLEIGHT_HAND_CAPTURE) out(`SLEIGHT_HAND_CAPTURE=${env.SLEIGHT_HAND_CAPTURE} in this environment still wins for servers started from here.\n`);
        return 0;
      }
      if (family === 'cursor' && op === 'style' && rest.length === 1 && ['ring', 'seam'].includes(rest[0])) {
        const value = writeHand({ style: rest[0] });
        out(`Cursor style: ${rest[0]}. ${value.enabled ? 'Start a new sleight session to use it.' : 'The hand is off, so it draws nothing yet. Turn it on with sleight-mcp hand on, then start a new sleight session.'}\n`);
        if (env.SLEIGHT_CURSOR_STYLE) out('SLEIGHT_CURSOR_STYLE in this environment still wins for servers started from here.\n');
        return 0;
      }
      if (family === 'cursor' && ['import', 'remove', 'check', 'list'].includes(op) || family === 'cursor' && op === 'style' && ['glove', 'sprite'].includes(rest[0])) {
        out('Windows character commands and glove drawing are not available yet. Use cursor style ring or seam.\n'); return 1;
      }
    } else if (family === 'turbo') {
      if (op === 'off' && !rest.length) { store.write('turbo.json', { version: 1, enabled: false }); out('turbo is off. sleight-mcp turbo on turns it back on.\n'); return 0; }
      if (op === 'status' && !rest.length) {
        const value = validTurbo(store.read('turbo.json')); out(`turbo     ${value.enabled ? 'on' : 'off'}\n`);
        out('Windows browser connections are not available yet; peer verification and trusted consent remain required.\n'); return 0;
      }
      if (op === 'on' && (!rest.length || rest.length === 2 && rest[0] === '--browser' && ['chrome', 'edge', 'brave'].includes(rest[1]))) {
        const id = rest[1] ?? 'chrome', browser = (await (discovery ?? createWindowsTurboDiscovery({ platform: 'win32' })).browsers()).find(b => b.id === id && b.installed);
        if (!browser) { out(`turbo stays off: ${id} was not found.\n`); return 1; }
        store.write('turbo.json', { version: 1, enabled: true, browser: id });
        out(`turbo is on with ${browser.name}.\nWindows browser connections are not available yet; peer verification and trusted consent remain required.\n`); return 0;
      }
      if (op === 'app') { out('Electron turbo settings are not available on Windows yet.\n'); return 1; }
    } else if (family === 'permissions') {
      const perms = () => validWindowsPermissions(store.read('permissions.json'));
      const update = change => { const before = perms(), next = change(before); if (next) store.write('permissions.json', validWindowsPermissions(next)); return !!next; };
      if ((!op || op === 'list') && !rest.length) {
        const value = perms();
        const pre = store.read('preapproved.json') ?? { version: 1, apps: [] };
        const apps = new PreapprovedApps(pre).list(), turbo = validTurbo(store.read('turbo.json'));
        if (apps.length || turbo.enabled) out('sleight may act in\n' + [...apps.map(app => `  ${app} · always · not used yet`),
          ...turbo.enabled ? [`  ${turbo.browser ?? 'its browser'} · turbo · not used yet`] : []].join('\n') + '\n' +
          'sleight-mcp permissions revoke <app|turbo|all> takes one away.\n');
        else out("sleight may act in: nothing beyond this session's approvals\n");
        if (value.apps.length || value.sites.length) out('Blocked\n' + [...value.apps.map(a => a.name ? `${a.name} (${a.id})` : a.id), ...value.sites].map(s => '  ' + s).join('\n') + '\n');
        out(value.only ? `Sites: only ${value.only.join(', ')} (turbo and browser windows on the engine path)\n` : "Sites: any site you haven't blocked (sleight-mcp permissions sites only <origin...> limits sleight to those)\n");
        out('Windows app driving and browser connections are not available yet.\n'); return 0;
      }
      if (['block', 'unblock'].includes(op) && rest.length === 1) {
        const name = rest[0].includes('://') ? siteOrigin(rest[0]) : rest[0].length <= 255 && BUNDLE_ID.test(rest[0]) ? rest[0] : undefined;
        if (!name) { out(usage(family)); return 2; }
        const site = name.includes('://');
        const changed = update(p => {
          const found = site ? p.sites.some(s => sameBlock(s, name)) : p.apps.some(a => a.id.toLowerCase() === name.toLowerCase());
          if (op === 'unblock') return found && { ...p, ...(site ? { sites: p.sites.filter(s => !sameBlock(s, name)) } : { apps: p.apps.filter(a => a.id.toLowerCase() !== name.toLowerCase()) }) };
          if (site ? coveringBlock(p.sites, name) : found) return false;
          return { ...p, ...(site ? { sites: [...p.sites, name] } : { apps: [...p.apps, { id: name }] }) };
        });
        out(changed ? op === 'block' ? `sleight won't act ${site ? 'on' : 'in'} ${name} from its next action, in every session.\n`
          : `sleight may act ${site ? 'on' : 'in'} ${name} again. Approvals still ask as before.\n`
          : `${name} ${op === 'block' ? 'is already blocked' : "isn't blocked"}.\n`); return 0;
      }
      if (op === 'sites' && rest[0] === 'all' && rest.length === 1) {
        update(p => p.only && { ...p, only: undefined }); out("sleight may act on any site you haven't blocked.\n"); return 0;
      }
      if (op === 'sites' && rest[0] === 'only' && rest.length > 1) {
        const sites = rest.slice(1).map(siteOrigin);
        if (sites.some(s => !s) || sites.length > 256) { out(usage(family)); return 2; }
        const only = sites.filter((site, i) => sites.findIndex(other => sameListed(other, site)) === i);
        update(p => ({ ...p, only })); out(`sleight acts only on ${only.join(', ')} from its next action, in turbo and in browser windows on the engine path. sleight-mcp permissions sites all lifts the limit.\n`); return 0;
      }
      if (op === 'revoke' && rest.length === 1) {
        const what = rest[0], site = what.includes('://') ? siteOrigin(what) : undefined;
        if (what.includes('://')) {
          if (!site) { out(usage(family)); return 2; }
          const value = perms();
          if (value.only?.length && value.only.every(s => sameListed(s, site))) {
            out(`${site} is the only site sleight may act on, so it stays. sleight-mcp permissions sites all lifts the limit, and sleight-mcp permissions block ${site} stops sleight there.\n`); return 1;
          }
          const changed = update(p => p.only?.some(s => sameListed(s, site)) && { ...p, only: p.only.filter(s => !sameListed(s, site)) });
          out(changed ? `${site} is off the sites sleight may act on.\n` : `${site} isn't on an allow-only list.\n`); return 0;
        }
        if (['turbo', 'all'].includes(what)) store.write('turbo.json', { version: 1, enabled: false });
        if (what === 'turbo') { out('Turbo is off. sleight-mcp turbo on turns it back on.\n'); return 0; }
        return store.withPreapprovedLock(({ absent = false } = {}) => {
          const pre = cleanPreapproved((absent ? undefined : store.read('preapproved.json')) ?? { version: 1, apps: [] });
          const grants = (absent ? undefined : store.read('electron-grants.json')) ?? { version: 2, grants: [] };
          if (!object(grants, ['version', 'grants']) || grants.version !== 2 || !Array.isArray(grants.grants) || grants.grants.length > 4096) invalid();
          const apps = pre.apps.filter(app => what !== 'all' && app.app !== what);
          const kept = grants.grants.filter(entry => what !== 'all' && entry?.record?.bundleId !== what && entry?.record?.name !== what);
          const removed = pre.apps.length - apps.length + grants.grants.length - kept.length;
          if (apps.length !== pre.apps.length) store.write('preapproved.json', { ...pre, apps });
          if (kept.length !== grants.grants.length) store.write('electron-grants.json', { ...grants, grants: kept });
          out(what === 'all' ? `Revoked everything sleight may do: ${pre.apps.length} apps, ${grants.grants.length} debugger grants and turbo. Blocks stay.\n`
            : removed ? `Revoked ${what} (${removed}). It asks again from its next action.\n` : `Nothing to revoke for ${what}.\n`); return 0;
        });
      }
      if (op === 'repair' && (!rest.length || rest.length === 1 && rest[0] === '--discard')) {
        store.repair?.('permissions.json');
        const value = rest[0] === '--discard' ? { version: 1, apps: [], sites: [] } : perms();
        store.write('permissions.json', value);
        out(`Repaired permissions.json: kept ${value.apps.length} blocked apps, ${value.sites.length} blocked sites. sleight acts again from its next action.\n`); return 0;
      }
      if (op === 'memory') { out('Windows control-recipe storage is not available yet.\n'); return 1; }
    }
    out(usage(family)); return 2;
  } catch (err) {
    if (['WINDOWS_FILE_UNSAFE', 'WINDOWS_SETTING_INVALID'].includes(err.message)) {
      const name = family === 'hand' || family === 'cursor' || family === 'stream' ? 'hand.json' : family + '.json';
      const file = typeof adapter.paths === 'function' ? adapter.join(adapter.paths().settings, name) : name;
      out(`Unsafe or unreadable settings: ${file}. Delete that file yourself and rerun this command, or use permissions repair for its ACL. Links, hardlinks and another owner's files must be resolved separately.\n`);
    }
    out(`${family} ${op ?? 'list'} failed: ${/^[A-Z][A-Z0-9_]+$/.test(err.message) ? err.message : 'WINDOWS_SETTINGS_FAILED'}\n`); return 1; }
}

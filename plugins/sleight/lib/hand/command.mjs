// The writers of hand.json: `sleight-mcp hand on|off|status`, `hand capture hidden|visible`, and the turbo menu's Ghost Hand
// row (the person's click in sleight's own window), which writes enabled exactly as hand on and off do. It uses turbo's atomic
// writer, which refuses a linked file or a shared folder, then reads the file back with the same reader the servers use.
import { userInfo } from 'node:os';
import { writeConfigFile } from '../direct-browser/turbo-setup.mjs';
import { handHostBuilt } from '../direct-browser/host.mjs';
import { CAPTURE_MODES, CURSOR_STYLES, characterIdValid, handConfigPath, handSetting, handStatusLines, readHandConfig } from './settings.mjs';

const usage = 'usage: sleight-mcp hand on\n       sleight-mcp hand off\n       sleight-mcp hand capture hidden|visible\n       sleight-mcp hand status\n';

/** Writes one field and keeps the other. An unsafe file is replaced only when enabled is given, since that says everything.
 *  Throws an error whose message is a code. */
export function writeHandSetting({ enabled, capture, style, character }, { path = handConfigPath(userInfo().homedir), uid = process.getuid() } = {}) {
  if (style !== undefined && !CURSOR_STYLES.includes(style) || character !== undefined && !characterIdValid(character)) throw Error('HAND_CONFIG_INVALID');
  const before = readHandConfig(path, uid);
  if (enabled === undefined && before.state === 'unsafe') throw Error('HAND_CONFIG_UNSAFE');
  const data = { version: 1, enabled: enabled ?? before.state === 'on' };
  if (before.state !== 'unsafe') for (const key of ['stream', 'labels', 'style', 'character']) if (before[key] !== undefined) data[key] = before[key];
  if (style !== undefined) data.style = style;
  if (character !== undefined) data.character = character;
  const kept = capture ?? (before.state !== 'unsafe' ? before.capture : undefined);
  if (kept) data.capture = kept;
  try { writeConfigFile(path, data, uid); }
  catch (error) { throw Error(/^[A-Z][A-Z0-9_]{0,127}$/.test(error?.message) ? error.message.replace(/^TURBO_/, 'HAND_') : error?.code ?? 'HAND_SETUP_FAILED'); }
  const after = readHandConfig(path, uid);
  if (after.state !== (data.enabled ? 'on' : 'off') || ['capture', 'style', 'character', 'stream', 'labels'].some(key => after[key] !== data[key])) throw Error('HAND_CONFIG_UNSAFE');
}

/** Exit code 0 on success, 1 on failure, 2 on usage. */
export function handCommand(args, { out = text => process.stdout.write(text), path = handConfigPath(userInfo().homedir), uid = process.getuid(),
  env = process.env, platform = process.platform, built = handHostBuilt } = {}) {
  const [op, ...rest] = args;
  const capture = op === 'capture' && rest.length === 1 && CAPTURE_MODES.includes(rest[0]) ? rest[0] : undefined;
  if (!(['on', 'off', 'status'].includes(op) && !rest.length || capture)) { out(usage); return 2; }
  if (op === 'status') { out(handStatusLines(handSetting({ env, platform, path }), built()).join('\n') + '\n'); return 0; }
  try { writeHandSetting(capture ? { capture } : { enabled: op === 'on' }, { path, uid }); }
  catch (error) {
    out(capture && error.message === 'HAND_CONFIG_UNSAFE' && readHandConfig(path, uid).state === 'unsafe'
      ? `hand capture failed: ${path} is unsafe to read. Run sleight-mcp hand on or off first.\n`
      : `hand ${args.join(' ')} failed: ${error.message} (if ${path} is a link or has another owner, delete it first)\n`);
    return 1;
  }
  if (capture) {
    out(capture === 'visible' ? 'Your screenshots and screen recordings show the ghost hand from the next action.\n'
      : 'Screenshots and screen recordings leave the ghost hand out from the next action.\n');
    if (env.SLEIGHT_HAND_CAPTURE) out(`SLEIGHT_HAND_CAPTURE=${env.SLEIGHT_HAND_CAPTURE} in this environment still wins for servers started from here.\n`);
    return 0;
  }
  out(op === 'on' ? 'The ghost hand is on. Start a new sleight session if it started with the hand off.\n'
    : 'The ghost hand is off. Running sessions hide it at once. sleight-mcp hand on turns it back on.\n');
  if (op === 'off' && env.SLEIGHT_HAND === '1') out('SLEIGHT_HAND=1 in this environment still keeps it on for servers started from here.\n');
  if (op === 'on' && env.SLEIGHT_HAND === '0') out('SLEIGHT_HAND=0 in this environment still keeps it off for servers started from here.\n');
  return 0;
}

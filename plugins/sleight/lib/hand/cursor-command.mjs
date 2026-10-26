// User CLI only. Character names and descriptions never enter an MCP prompt or tool result.
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { charactersDirectory, prepareCharacterImport, installCharacter, listCharacters, checkCharacter, removeCharacter, characterCallout, resolveCharacterStates } from './character.mjs';
import { characterFrame } from './character-frame.mjs';
import { CURSOR_STYLES, LINES_MODES, handConfigPath, handSetting } from './settings.mjs';
import { writeHandSetting } from './command.mjs';
import { handHostBuilt, prepareHandHost } from '../direct-browser/host.mjs';

// The live host's own checks for an installed character, through its sandboxed decode child (consent-host --check-character).
const hostCheckCharacter = async frame => {
  const host = await prepareHandHost();
  if (host.status !== 'ready') throw Error(`the hand host is unavailable (${host.code ?? host.status})`);
  return host.checkCharacter(frame);
};
const handLine = s => s.reason === 'unsafe' ? 'off (hand.json is unsafe to read; run sleight-mcp hand on or off to replace it)'
  : s.enabled ? 'on' : s.reason === 'env' ? 'off (SLEIGHT_HAND=0)' : s.reason === 'platform' ? 'off (macOS only)' : 'off';
const usage = 'usage: sleight-mcp cursor import <folder> [--yes]\n       sleight-mcp cursor list\n       sleight-mcp cursor check <id>\n       sleight-mcp cursor remove <id>\n       sleight-mcp cursor style <glove|ring|seam|sprite> [<character-id>] [--perch]\n       sleight-mcp cursor lines on|off\n       sleight-mcp cursor status\n';
function ask(input, out, prompt) {
  out(prompt);
  return new Promise(resolve => {
    const lines = createInterface({ input, terminal: false });
    let answered = false;
    lines.once('line', answer => { answered = true; resolve(answer); lines.close(); });
    lines.once('close', () => { if (!answered) resolve(''); });
  });
}
/** Exit 0: done or declined, 1: validation/IO/non-TTY refusal, 2: usage. */
export async function cursorCommand(args, { out = text => process.stdout.write(text), input = process.stdin, env = process.env,
  root = env.SLEIGHT_CURSOR_TEST === '1' ? env.SLEIGHT_CHARACTERS_DIR ?? charactersDirectory() : charactersDirectory(),
  uid = process.getuid(), builtins = true, path = handConfigPath(), platform = process.platform, built = handHostBuilt, hostCheck = hostCheckCharacter,
  confirm = prompt => ask(input, out, prompt) } = {}) {
  const [op, ...all] = args, options = { root, uid, builtins };
  // --perch goes with style sprite only: the character sits on the target window instead of trailing the ring.
  const perch = op === 'style' && all[0] === 'sprite' && all.at(-1) === '--perch', rest = perch ? all.slice(0, -1) : all;
  if (!(op === 'lines' && rest.length === 1 && LINES_MODES.includes(rest[0]) || op === 'import' && (rest.length === 1 || rest.length === 2 && rest[1] === '--yes') && !rest[0].startsWith('--') ||
      ['list', 'status'].includes(op) && rest.length === 0 || ['check', 'remove'].includes(op) && rest.length === 1 ||
      op === 'style' && CURSOR_STYLES.includes(rest[0]) && (rest.length === 1 || rest.length === 2 && rest[0] === 'sprite' && !rest[1].startsWith('--')))) { out(usage); return 2; }
  try {
    if (op === 'status') {
      const s = handSetting({ env, path, platform });
      out([`hand      ${handLine(s)}`,
        `style     ${s.style ?? 'glove'}${s.styleReason === 'env' ? ' (SLEIGHT_CURSOR_STYLE)' : s.styleReason === 'env-invalid' ? ' (invalid SLEIGHT_CURSOR_STYLE)' : ''}`,
        `character ${s.character ?? 'none'}`, `perch     ${s.perch ? 'on' : 'off'}`, `lines     ${s.lines ?? 'on'}`,
        `stream    ${s.stream ? 'on' : 'off'}`, `labels    ${s.labels ?? 'off'}`,
        `narration ${s.narration ?? 'off'}`, `voice     ${s.voice?.id ?? 'system default'} (rate ${s.voice?.rate ?? 0.5})`,
        `host      ${built() ? 'compiled' : 'not compiled'}`].join('\n') + '\n');
      if (!s.enabled && (s.style ?? 'glove') !== 'glove') out('The hand is off, so no style draws. Turn it on with sleight-mcp hand on.\n');
    } else if (op === 'style') {
      const style = rest[0], character = rest[1] ?? handSetting({ env: {}, path, platform }).character;
      if (style === 'sprite') {
        if (!character) { out('cursor style sprite needs an installed character id. Run sleight-mcp cursor list.\n'); return 1; }
        checkCharacter(character, options);
      }
      // perch: on with --perch; a sprite style without it turns a saved perch off and otherwise writes nothing new.
      const before = handSetting({ env: {}, path, platform }).perch === true;
      writeHandSetting({ style, ...style === 'sprite' ? { character, ...perch || before ? { perch } : {} } : {} }, { path, uid });
      const after = handSetting({ env: {}, path, platform });
      out(`Cursor style: ${style}${style === 'sprite' ? perch ? ' (perched on the window)' : ' (trailing the ring)' : ''}. ${after.enabled ? 'Start a new sleight session to use it.' : 'The hand is off, so it draws nothing yet. Turn it on with sleight-mcp hand on, then start a new sleight session.'}\n`);
      if (env.SLEIGHT_CURSOR_STYLE) out('SLEIGHT_CURSOR_STYLE in this environment still wins for servers started from here.\n');
    } else if (op === 'lines') {
      writeHandSetting({ lines: rest[0] }, { path, uid });
      out(`Character lines: ${rest[0]}. ${rest[0] === 'on' ? 'A sprite character with lines says them at a few moments of a task.' : 'The character stays quiet.'}\n`);
    } else if (op === 'import') {
      const character = prepareCharacterImport(rest[0], { uid }); out(characterCallout(character));
      if (rest[1] !== '--yes') {
        if (!input.isTTY) { out('Import needs a TTY to confirm. Use --yes to import without a prompt.\n'); return 1; }
        if (!/^(y|yes)$/i.test((await confirm('Import this character? [y/N] ')).trim())) { out('Import cancelled.\n'); return 0; }
      }
      installCharacter(character, options);
      out(`Imported ${character.manifest.id}. The sprite stays hidden.\nTurn it on with sleight-mcp cursor style sprite ${character.manifest.id}\n`);
    } else if (op === 'check') {
      const character = checkCharacter(rest[0], options);
      out(characterCallout(character, { installed: true }));
      // The host's checks need its decoded pixels, which the JS validator never reads.
      if (!built()) { out('Host check skipped: the hand host is not compiled yet. It compiles on first use.\n'); return 0; }
      const result = await hostCheck(characterFrame(character, { nonce: randomBytes(32).toString('hex'), seq: 0, resolve: resolveCharacterStates }));
      if (!result.loaded) { out(`Host check: refused (${result.reason}). sleight shows the ring instead of this character.\n`); return 1; }
      out(`Host check: draws${result.warnings.length ? ` (warnings: ${result.warnings.join(', ')})` : ''}.\n`);
    }
    else if (op === 'remove') { out(removeCharacter(rest[0], options) ? `Removed ${rest[0]}.\n` : `Skipped ${JSON.stringify(rest[0])}: not a character folder.\n`); }
    else {
      const characters = listCharacters(options);
      out(characters.length ? characters.map(c => c.skipped ? `Skipped ${JSON.stringify(c.id)}: ${c.reason}.`
        : c.error ? `${JSON.stringify(c.id).slice(1, -1)}: needs repair: ${c.error}`
        : `${c.manifest.id}: ${c.manifest.name}${c.builtin ? ' [built-in]' : ''} (${c.resolved.filter(s => s.own).length} of ${c.resolved.length} states)`).join('\n') + '\n' : 'No characters installed.\n');
      if (characters.some(c => c.error)) return 1;
    }
    return 0;
  } catch (error) { out(`cursor ${op} failed: ${error.message}\n`); return 1; }
}

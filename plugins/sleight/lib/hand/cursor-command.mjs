// User CLI only. Character names and descriptions never enter an MCP prompt or tool result.
import { createInterface } from 'node:readline';
import { charactersDirectory, prepareCharacterImport, installCharacter, listCharacters, checkCharacter, removeCharacter, characterCallout } from './character.mjs';

const usage = 'usage: sleight-mcp cursor import <folder> [--yes]\n       sleight-mcp cursor list\n       sleight-mcp cursor check <id>\n       sleight-mcp cursor remove <id>\n';
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
  root = charactersDirectory(env), uid = process.getuid(), confirm = prompt => ask(input, out, prompt) } = {}) {
  const [op, ...rest] = args, options = { root, uid };
  if (op === 'style' && rest.length === 1 && ['sprite', 'ring', 'overlay'].includes(rest[0])) { out('coming in 1.5.1\n'); return 0; }
  if (!(op === 'import' && (rest.length === 1 || rest.length === 2 && rest[1] === '--yes') && !rest[0].startsWith('--') ||
      op === 'list' && rest.length === 0 || ['check', 'remove'].includes(op) && rest.length === 1)) { out(usage); return 2; }
  try {
    if (op === 'import') {
      const character = prepareCharacterImport(rest[0], { uid }); out(characterCallout(character));
      if (rest[1] !== '--yes') {
        if (!input.isTTY) { out('Import needs a TTY to confirm. Use --yes to import without a prompt.\n'); return 1; }
        if (!/^(y|yes)$/i.test((await confirm('Import this character? [y/N] ')).trim())) { out('Import cancelled.\n'); return 0; }
      }
      installCharacter(character, options);
      out(`Imported ${character.manifest.id}. The sprite stays hidden.\nTurn it on with sleight-mcp cursor style sprite\n`);
    } else if (op === 'check') out(characterCallout(checkCharacter(rest[0], options)));
    else if (op === 'remove') { removeCharacter(rest[0], options); out(`Removed ${rest[0]}.\n`); }
    else {
      const characters = listCharacters(options);
      out(characters.length ? characters.map(c => `${c.manifest.id}: ${c.manifest.name} (${c.resolved.filter(s => s.own).length} of ${c.resolved.length} states)`).join('\n') + '\n' : 'No characters installed.\n');
    }
    return 0;
  } catch (error) { out(`cursor ${op} failed: ${error.message}\n`); return 1; }
}

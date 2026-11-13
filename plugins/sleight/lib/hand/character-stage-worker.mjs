// Internal worker, invoked only by character-stage.mjs inside a private, network-denied render bank.
import * as fs from 'node:fs';
import { renderStage, CAST } from '../../skills/make-character/tool/stage.mjs';
const [id, output, ...extra] = process.argv.slice(2);
if (extra.length || !CAST.includes(id) || output !== fs.realpathSync(process.cwd()) || fs.realpathSync(output) !== output) throw Error('Invalid stage worker arguments');
process.umask(0o077);
await renderStage(id, output);

import { createInterface } from 'node:readline/promises';

export async function terminalConfirm(word, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY) throw new Error('routine changes require an interactive terminal');
  const terminal = createInterface({ input, output });
  try { return (await terminal.question(`Type ${word} to continue: `)).trim() === word; }
  finally { terminal.close(); }
}

// Benchmark tasks. Each one sets up what it needs in a scratch folder, gives
// Claude a prompt, and checks the outcome itself (a file on disk, or the exact
// answer), never by asking Claude whether it succeeded.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Calculator shows digit grouping ("1,024"), and Claude reports what it shows.
const hasNumber = (answer, n) => new RegExp(`(^|\\D)${n}(\\D|$)`).test(answer.replace(/(?<=\d)[,\u202f\u00a0 ](?=\d{3})/g, ''));

// The only apps a benchmark run may approve (see approve.mjs).
export const BENCH_APPS = ['Calculator', 'TextEdit'];

export const tasks = [
  {
    id: 'calculator-click',
    app: 'Calculator',
    prompt: () => 'Use undertow to work out 17 × 23 in Calculator by clicking its buttons in the background. Reply with only the number the display shows.',
    check: ({ answer }) => hasNumber(answer, 391) || 'answer does not contain 391',
  },
  {
    id: 'calculator-menu',
    app: 'Calculator',
    prompt: () => 'Use undertow to switch Calculator to Scientific mode from its View menu, then compute 2 to the power of 10 with its buttons. Reply with only the number the display shows.',
    check: ({ answer }) => hasNumber(answer, 1024) || 'answer does not contain 1024',
  },
  {
    id: 'textedit-save',
    app: 'TextEdit',
    prompt: ({ dir, nonce }) =>
      `Use undertow to create a new TextEdit document, make it plain text (Format menu, Make Plain Text), type exactly "undertow bench ${nonce}", and save it as ${join(dir, `${nonce}.txt`)}. Then close the document.`,
    check: ({ dir, nonce }) => {
      const path = join(dir, `${nonce}.txt`);
      let text;
      try { text = readFileSync(path, 'utf8'); } catch { return `${path} was not saved`; }
      return text.trim() === `undertow bench ${nonce}` || `${path} holds ${JSON.stringify(text.slice(0, 80))}`;
    },
  },
  {
    id: 'textedit-edit',
    app: 'TextEdit',
    setup: ({ dir, nonce }) => writeFileSync(join(dir, `${nonce}-edit.txt`), 'alpha beta gamma\n'),
    prompt: ({ dir, nonce }) =>
      `Use undertow to open ${join(dir, `${nonce}-edit.txt`)} in TextEdit, replace the word "beta" with "delta", save, and close the document.`,
    check: ({ dir, nonce }) => {
      const text = readFileSync(join(dir, `${nonce}-edit.txt`), 'utf8');
      return text.trim() === 'alpha delta gamma' || `file holds ${JSON.stringify(text.slice(0, 80))}`;
    },
  },
];

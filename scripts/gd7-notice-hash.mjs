// Print the hash used by tests/prompt-budget.test.mjs after a refusal-text change.
import { createHash } from 'node:crypto';
import { noticeInventory, sharedNoticeInventory, taggedNoticeInventory, hookNoticeInventory } from '../bench/prompt-budget.mjs';
import { FIRST_WINDOW_RULE, FIRST_WINDOW_LEAN_RULE } from '../plugins/sleight/lib/engine-app-docs.mjs';
import { nativeArgumentError } from '../plugins/sleight/lib/native-arguments.mjs';
const recovery = ['pressKey', 'typeText'].flatMap(method => [nativeArgumentError(method, [52, 'fixture']), nativeArgumentError(method, [])]);
const texts = [...noticeInventory(), ...sharedNoticeInventory(), ...taggedNoticeInventory(), ...hookNoticeInventory()].map(row => row.text).concat(FIRST_WINDOW_RULE, FIRST_WINDOW_LEAN_RULE, recovery);
console.log(createHash('sha256').update(JSON.stringify(texts)).digest('hex'));

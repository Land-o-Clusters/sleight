// Legacy statement consumers from c4175f79. This fixture never reads Git history.
import * as text from './text-save.mjs';
import * as menu from './menu-continuation.mjs';
import * as tab from './tab-probe.mjs';
export const BASE = 'c4175f7917fadb10bce86d02d7672df416105aa8';
export const sources = {
  "plugins/sleight/lib/text-save.mjs": "170c229f051f80acbd0c8b810d14167bebe84ba0b3cb938e61be5f6785342648",
  "plugins/sleight/lib/menu-continuation.mjs": "7d1a8c550766dbe96049e42b465c41b3900a326cc442bc3457b31ba3018d6bec",
  "plugins/sleight/lib/tab-probe.mjs": "a6a205af375e0d1a4f167905e8c21a21050eafa77b0581265a4e476c49105a92",
  "plugins/sleight/lib/flow-rules.mjs": "c6b2f899cb1236d5b6072d6bddddbd2f39959c872af88c770c92743c418fa0db",
  "plugins/sleight/lib/code-line-terminators.mjs": "21bff7cc38c27aa86cd7b63158dab45e71e5057beda5b2427c6f34459591f8fe"
};
export const legacyConsumers = Object.freeze({ text, menu, tab, sources });

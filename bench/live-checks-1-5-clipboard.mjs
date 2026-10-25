import { randomUUID } from 'node:crypto';
import { clipboardContains } from '../plugins/sleight/lib/clipboard-recovery.mjs';

// Independent of the paste feature: keep all original readable representations
// in memory, and retain them for a cleanup retry if the feature or restoration fails.
export function createClipboardProbe(io) {
  let original, sentinel, pending = Promise.resolve();
  const serial = action => {
    const task = pending.then(action);
    pending = task.catch(() => {});
    return task;
  };
  const locked = async action => {
    await io({ op: 'acquire' });
    try { return await action(); } finally { await io({ op: 'release' }); }
  };
  const read = () => io({ op: 'read', maxBytes: 32 * 1024 * 1024 });
  return {
    async stage() {
      await serial(() => locked(async () => {
        if (original) throw Error('Clipboard probe already staged');
        original = await read();
        sentinel = [[{ type: 'public.utf8-plain-text', data: Buffer.from('sleight-lc1-' + randomUUID()).toString('base64') }]];
        await io({ op: 'write', expectedCount: original.count, localOnly: true, items: sentinel });
        if (!clipboardContains((await read()).items, sentinel)) throw Error('Clipboard sentinel could not be staged');
      }));
    },
    async verify() {
      if (!sentinel || !clipboardContains((await read()).items, sentinel)) throw Error('Clipboard sentinel was not restored after paste');
    },
    async restore() {
      await serial(async () => {
        if (!original) return;
        await locked(async () => {
          const current = await read();
          await io({ op: 'write', expectedCount: current.count, localOnly: true, items: original.items });
          if (!clipboardContains((await read()).items, original.items)) throw Error('Original clipboard restoration unconfirmed');
          original = undefined; sentinel = undefined;
        });
      });
    },
    async close() { try { await this.restore(); } finally { await io.close?.(); } },
  };
}

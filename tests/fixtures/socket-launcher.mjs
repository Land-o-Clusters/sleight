// Production shell launch and cleanup, with an offline engine and no host health probes.
import { run } from '../../plugins/sleight/lib/launch.mjs';
import { createPaymentCard } from '../../plugins/sleight/lib/payment-card.mjs';
import { appendFileSync } from 'node:fs';
await run({ shellRoute: true, leaseDirectory: process.argv[2],
  directBrowser: new Proxy({}, { get() { throw new Error('shell launcher touched the supplied directBrowser'); } }),
  paymentCardFactory: options => createPaymentCard({ ...options,
    timeoutMs: process.env.SLEIGHT_TEST_CARD_MODE === 'unanswered' ? 150 : 120000,
    open: async () => ({
    present: (id, data, choices, answer) => {
      appendFileSync(process.env.SLEIGHT_TEST_ENGINE_LOG, JSON.stringify({ event: 'panel', data, choices }) + '\n');
      const mode = process.env.SLEIGHT_TEST_CARD_MODE;
      if (mode === 'unanswered') return;
      if (mode) setTimeout(() => answer({ choice: mode === 'allow' ? 'once' : 'cancel' }), 150);
      else answer({ choice: 'cancel' });
    }, authenticate: () => true, close() {},
  }) }),
  healthHelperFactory: () => ({ close: async () => {}, keyboardTaps: async () => [] }),
});

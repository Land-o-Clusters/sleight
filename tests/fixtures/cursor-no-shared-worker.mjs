import { serveV3Worker } from '../../plugins/sleight/lib/direct-browser/worker.mjs';
import { sharedBrowserHand } from '../../plugins/sleight/lib/hand/browser-hand.mjs';
import { createHandSettingReader } from '../../plugins/sleight/lib/hand/settings.mjs';

const setting = createHandSettingReader({ path: process.env.CURSOR_FIXTURE_SETTING, env: {}, platform: 'darwin' });
const hand = sharedBrowserHand({ SLEIGHT_HAND: '1' }, { setting });
let reads = 0, boxes = 0;
const worker = serveV3Worker({ browser: 'bfixture', channel: process, begin: async () => ({
  async call() {
    const token = hand.step({ op: 'click', page: { locator() { reads++; throw Error('no shared host must not read metrics'); } },
      locator: { boundingBox() { boxes++; throw Error('no shared host must not read boxes'); } } });
    hand.finish(token);
    await new Promise(resolve => setImmediate(resolve));
    // Even a stray frame must not tear down turbo.
    process.send({ version: 3, hand: { kind: 'click' } });
    return { text: JSON.stringify({ reads, boxes, sharedUi: process.argv.includes('--shared-ui') }), isError: false };
  },
  delivered: () => true,
  end: async () => { hand.close(); return { revoked: true, cleanup: [] }; },
}) });
process.on('disconnect', () => { hand.close(); });
worker.ready();

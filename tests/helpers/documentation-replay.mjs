import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { installedBrowserRenderer } from './installed-docs.mjs';
import { loadInstalledDocumentation } from '../../plugins/sleight/lib/canonical-documentation.mjs';
import { MODULES_REL } from '../../plugins/sleight/lib/setup.mjs';

// Pure bundle rendering and in-memory MCP streams. No engine, app or host launch.
export async function replayInstalledDocumentation(createRelay, app = process.env.SLEIGHT_CHATGPT_APP || '/Applications/ChatGPT.app') {
  const loaded = loadInstalledDocumentation({ app });
  const doc = name => readFileSync(join(app, MODULES_REL, '@oai/cua/docs', `tinysky-alt-${name}.md`), 'utf8');
  const native = doc(loaded.coreNames[0]) + '\n' + doc('confirmations');
  const renderer = installedBrowserRenderer(app);
  const browser = doc('other-browser-apis') + '\n\n' + await renderer.readBrowser({
    id: '1', name: 'Google Chrome', type: 'extension', capabilities: { browser: [], tab: [] },
  });
  const tree = readFileSync(new URL('../fixtures/calculator-tree.txt', import.meta.url), 'utf8');
  const largeTree = 'Window: "Example", App: Example.\n0 standard window Example\n' +
    Array.from({ length: 300 }, (_, i) => `\t${i + 1} text Row ${i + 1}`).join('\n');
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const text = text => ({ type: 'text', text });
  const cases = [
    ['native separate', {}, [native, tree]],
    ['native joined', {}, [native + '\n' + tree]],
    ['lean separate', { leanFirst: true }, [native, tree]],
    ['lean joined', { leanFirst: true }, [native + '\n' + tree]],
    ['grok native', {}, [native, tree], true],
    ['warm native', { warmRepl: true }, [tree]],
    ['browser first', {}, [native, browser, tree]],
    ['browser first large tree', {}, [native, browser, largeTree]],
    ['grok browser', {}, [native, browser, largeTree], true],
  ];
  const results = {};
  for (const [name, options, first, grok] of cases) {
    const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
    const received = [], sent = [];
    for (const [stream, list] of [[clientOut, received], [serverIn, sent]])
      stream.on('data', bytes => list.push(...String(bytes).trim().split('\n').map(JSON.parse)));
    // Production trust loads the installed bundle. No declared fixture canonicals.
    const relay = createRelay({ clientIn, clientOut, serverIn, serverOut,
      sessionId: 'di1r3-replay', inputLease: false, changeReview: false, openShot: false,
      firstCallRules: 'Keep the skill rules.', dedupeRules: true, ...options });
    const send = msg => clientIn.write(JSON.stringify(msg) + '\n');
    const reply = (id, content) => serverOut.write(JSON.stringify({ id, result: { content: content.map(text) } }) + '\n');
    const call = (id, code) => send({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } });
    try {
      if (grok || options.warmRepl) {
        send({ id: -1, method: 'initialize', params: { capabilities: {}, ...(grok ? { clientInfo: { name: 'grok-shell-test' } } : {}) } });
        reply(-1, []); send({ method: 'notifications/initialized' }); await tick();
      }
      if (options.warmRepl) {
        const warm = sent.find(msg => msg.params?.arguments?.title === 'Prepare sleight REPL');
        if (!warm) throw Error('missing warmup');
        reply(warm.id, [native]); await tick();
      }
      const browserFirst = name.includes('browser');
      call(1, browserFirst ? 'let b = await cua.getBrowser({id:"1"});' : 'let app = await cua.getApp("Example");');
      reply(1, first); await tick();
      call(2, browserFirst ? 'await cua.listApps();' : 'await app.getAXState();');
      reply(2, [tree]); await tick();
      call(3, 'nodeRepl.write("done")'); reply(3, ['done']); await tick();
      const wire = JSON.stringify(received);
      results[name] = { sha256: createHash('sha256').update(wire).digest('hex'), bytes: Buffer.byteLength(wire),
        docs: received.flatMap(msg => msg.result?.content ?? []).filter(c => c.text?.startsWith('## Computer Use\n'))
          .map(c => ({ chars: c.text.length, bytes: Buffer.byteLength(c.text) })), wire: received };
    } finally {
      relay.dispose();
      for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy();
    }
  }
  return { nativeChars: native.length, nativeBytes: Buffer.byteLength(native), browserChars: browser.length,
    browserBytes: Buffer.byteLength(browser), canonicalLengthBound: loaded.maxLength, results };
}

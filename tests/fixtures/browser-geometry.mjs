import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHandClient, privateHandGeometry, shareConsent } from '../../plugins/sleight/lib/hand/client.mjs';

export function sourceURL(file, transform = source => source) {
  const url = new URL('../../plugins/sleight/lib/' + file, import.meta.url);
  let source = transform(readFileSync(url, 'utf8'));
  source = source.replace(/(from\s*|import\s*\()(['"])(\.{1,2}\/[^'"]+)\2/g,
    (match, prefix, quote, path) => prefix + quote + new URL(path, url).href + quote);
  return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
}
export const sourceModule = (file, transform) => import(sourceURL(file, transform));

export const replaceSite = (source, from, to) => {
  assert.ok(source.includes(from), 'named mutation site ' + from);
  return source.replace(from, to);
};

export function browserHandModule({ geometryURL, trustedURL } = {}) {
  const variant = process.env.GP3B_VARIANT;
  if (!variant && !geometryURL && !trustedURL) return import('../../plugins/sleight/lib/hand/browser-hand.mjs');
  return sourceModule('hand/browser-hand.mjs', source => {
    if (geometryURL) source = source.replaceAll("'../direct-browser/geometry-observation.mjs'", JSON.stringify(geometryURL));
    if (trustedURL) source = source.replaceAll("'../direct-browser/trusted-dom.mjs'", JSON.stringify(trustedURL));
    if (variant === 'reuse-seen-removed') source = replaceSite(source, '!seen.has(observation)', 'true');
    if (variant === 'unbound-acquisition') source = replaceSite(source, 'browserLayoutRequest(observation) === request.token && ', '');
    if (variant === 'public-aim') source = replaceSite(source,
      "if (!geometryProducer?.state.turn) publish(token, 'aim');", "publish(token, 'aim');");
    if (variant === 'repeat-end') source = replaceSite(source,
      'if (!turn || ending || channel.state.pending) return false;', 'if (!turn || channel.state.pending) return false;');
    if (variant === 'pending-end') source = replaceSite(source,
      'if (!turn || ending || channel.state.pending) return false;', 'if (!turn || ending) return false;');
    if (variant === 'worker-clock') {
      source = replaceSite(source, 'latestBrowserLayout, watchBrowserLayout', 'latestBrowserLayout, browserLayoutInterval, watchBrowserLayout');
      source = replaceSite(source, 'function collect(page, observation, interval) {',
        'function collect(page, observation, interval) { interval = browserLayoutInterval(observation);');
    }
    return source;
  });
}

export function trustedSourceURL() {
  if (process.env.GP3B_VARIANT !== 'main-retention') return;
  return sourceURL('direct-browser/trusted-dom.mjs', source => replaceSite(source,
    "document = await utility.evaluateExpressionHandle(expression((el, unused, read) => read(el, 'ownerDocument')), { isFunction: true }, [pinned]);",
    "document = await (await frame.mainContext()).evaluateExpressionHandle('([el]) => { void el.textContent; return el.ownerDocument; }', { isFunction: true }, [node]);"));
}
export const trustedModule = () => import(trustedSourceURL() ?? new URL('../../plugins/sleight/lib/direct-browser/trusted-dom.mjs', import.meta.url).href);

export async function geometryModule() {
  const url = new URL('../../plugins/sleight/lib/direct-browser/geometry-observation.mjs', import.meta.url);
  const variant = process.env.GP3_VARIANT;
  if (!variant) return import(url.href);
  let source = readFileSync(url, 'utf8');
  const replace = (from, to) => { assert.ok(source.includes(from), 'named mutation site ' + from); source = source.replace(from, to); };
  if (['main-getter', 'recycled-content', 'closed-shadow'].includes(variant))
    replace('node.semantic !== identity.semantic ||', 'false ||');
  if (['main-getter', 'recycled-content', 'closed-shadow', 'same-label', 'navigation'].includes(variant))
    replace('doc.byId.get(doc.document).semantic !== identity.documentSemantic ||', 'false ||');
  if (variant === 'same-label') {
    replace('doc.byId.get(identity.backendNodeId)', '(doc.byId.get(identity.backendNodeId) ?? [...doc.byId.values()].find(row => row.context === identity.context))');
    replace('node.semantic !== identity.semantic ||', 'false ||');
  }
  if (['cssom', 'sticky-scroll', 'nested-scroll'].includes(variant)) {
    replace('semantic: node.semantic, context: node.context', 'oldPaint: node.paint, semantic: node.semantic, context: node.context');
    replace('const r = node.paint,', 'const r = identity.oldPaint,');
  }
  if (variant === 'partial-clip') replace('r2 <= x || b2 <= y', 'r[0] + r[2] / 2 < v[0] || r[1] + r[3] / 2 < v[1] || r2 <= x || b2 <= y');
  if (variant === 'oopif') replace('value.scope.frames.length !== 1 ||', 'false ||');
  if (variant === 'zoom') replace('const { origin, scale, viewport: v, bounds: b } = evidence;', 'const { origin, viewport: v, bounds: b } = evidence; const scale = 1;');
  if (variant === 'navigation') {
    replace('identity.epoch !== value.epoch ||', 'false ||');
    replace('identity.document !== doc.document ||', 'false ||');
    replace('doc.byId.get(identity.backendNodeId)', '(doc.byId.get(identity.backendNodeId) ?? [...doc.byId.values()].find(row => row.context === identity.context))');
    replace('node.semantic !== identity.semantic ||', 'false ||');
  }
  if (variant === 'wrong-window') replace('origin[0] < b[0] || origin[1] < b[1] || right > b[0] + b[2] || bottom > b[1] + b[3]', 'false');
  if (variant === 'mixed-generation') replace('evidence.capture !== observation ||', 'false ||');
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

export async function handHarness(t, api = { createHandClient, privateHandGeometry, shareConsent }) {
  const child = new EventEmitter(); child.pid = 12345; child.lines = [];
  child.stdin = new EventEmitter(); child.stdin.writableLength = 0;
  child.stdin.write = line => { child.lines.push(...line.trim().split('\n').map(JSON.parse)); return true; };
  child.stdin.end = () => { child.exitCode = 0; child.emit('exit', 0, null); };
  child.stdout = new EventEmitter(); child.stdio = [child.stdin, child.stdout, null, new EventEmitter(), new EventEmitter()];
  for (const stream of child.stdio.slice(3)) { stream.write = () => true; stream.destroy = () => {}; }
  const client = api.createHandClient({ setting: () => ({ enabled: true, style: 'ring' }), watch: () => {}, permissions: null, usage: null,
    built: () => true, prepare: async () => ({ status: 'ready', spawn: () => child }) });
  t.after(() => client.close());
  await api.shareConsent(); await new Promise(resolve => setImmediate(resolve));
  const channel = api.privateHandGeometry(client), frames = () => child.lines.filter(f => f.hand === 'stage-producer');
  let acknowledged = 0;
  const ack = () => {
    for (const frame of frames().slice(acknowledged)) {
      child.stdout.emit('data', JSON.stringify({ hand: 'stage-producer-ack', nonce: frame.nonce,
        session: frame.session, turn: frame.turn, seq: frame.seq, op: frame.op, accepted: true }) + '\n');
      acknowledged++;
    }
  };
  return { client, channel, frames, ack, lines: child.lines };
}

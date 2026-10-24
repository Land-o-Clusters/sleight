import { readCode } from './document-scope.mjs';
import { selectedBrowserCode } from './browser-discovery.mjs';

// outcomes: the session records action outcomes, so the guard this installs carries that code (document-scope.mjs).
export function replSetupCode({ browserChoice, scope, token = scope, outcomes = false, completeness = false } = {}) {
  const setup = readCode('void 0;', { acknowledge: true, outcomes, completeness });
  if (!browserChoice) return setup;
  const query = JSON.stringify({ extensionInstanceId: browserChoice.extensionInstanceId });
  return setup + '\n' + selectedBrowserCode(`{
    const prepared = { key: ${JSON.stringify(JSON.stringify([browserChoice, scope]))}, token: ${JSON.stringify(token)} };
    globalThis.__sleightBrowserReadiness = prepared;
    let record;
    try {
      const browser = await cua.getBrowser(${query});
      record = globalThis.__sleightSelectedBrowser;
      if (record?.key !== prepared.key || record.browser !== browser) throw new Error('Browser readiness identity changed.');
      delete globalThis.__sleightSelectedBrowser;
      const tabs = await browser.tabs.list();
      if (!Array.isArray(tabs) || tabs.length) throw new Error('Browser readiness requires an empty session.');
      const choice = ${JSON.stringify(browserChoice)};
      const rows = (await cua.listBrowsers({ emit: false })).filter(row => row.type === 'extension' &&
        row.metadata?.extensionInstanceId === choice.extensionInstanceId && (!choice.profileName || row.profileName === choice.profileName));
      if (rows.length !== 1 || rows[0].id !== browser.browserId) throw new Error('Browser readiness identity changed.');
      if (!prepared.cancelled) prepared.record = record;
    } catch (error) {
      if (globalThis.__sleightSelectedBrowser === record) delete globalThis.__sleightSelectedBrowser;
      prepared.cancelled = true;
      throw error;
    }
  }`, browserChoice, scope);
}

export function browserWarmupUseCode(code, { browserChoice, scope, token = scope, confirmed } = {}) {
  if (!browserChoice) return code;
  return `{
    const prepared = globalThis.__sleightBrowserReadiness;
    if (prepared) {
      prepared.cancelled = true;
      delete globalThis.__sleightBrowserReadiness;
      if (${!!confirmed} && prepared.token === ${JSON.stringify(token)} &&
          prepared.key === ${JSON.stringify(JSON.stringify([browserChoice, scope]))} && prepared.record &&
          !globalThis.__sleightSelectedBrowser) globalThis.__sleightSelectedBrowser = prepared.record;
    }
  }\n` + code;
}

export class ReplWarmup {
  constructor({ enabled, request, resume, refuse, abort, setup = replSetupCode }) {
    Object.assign(this, { request, resume, refuse, abort, setup });
    this.state = enabled ? 'cold' : 'off';
    this.waiting = [];
    this.docs = [];
  }

  hold(msg) {
    if (msg.method === 'initialize') this.initializeId = msg.id;
    if (msg.method !== 'tools/call' || !['js', 'js_reset'].includes(msg.params?.name)) return false;
    // In-process callers without MCP initialization keep the ordinary first-call path.
    if (this.state === 'cold') this.state = 'used';
    if (this.state !== 'warming') return false;
    this.waiting.push(msg);
    return true;
  }

  sent(msg) {
    if (msg.method === 'notifications/initialized') { this.notified = true; this.start(); }
  }

  reply(msg) {
    if (this.initializeId === undefined || msg.id !== this.initializeId || msg.method !== undefined) return;
    this.ready = !!msg.result && !msg.error && !msg.result.isError;
    if (this.ready) this.start();
  }

  start() {
    if (this.state !== 'cold' || !this.ready || !this.notified) return;
    this.state = 'warming';
    try { Promise.resolve(this.request(this.setup())).then(reply => this.finish(reply), () => this.finish({})); }
    catch { this.finish({}); }
  }

  finish(reply) {
    if (this.state !== 'warming') return;
    this.state = 'done';
    this.retainDocs(reply);
    for (const msg of this.waiting.splice(0)) this.resume(msg);
  }

  retainDocs(reply) {
    if (this.state === 'cancelled') return;
    // A private call can consume the engine's first-call docs even if setup fails.
    // Deliver every docs block to the first real JS result, through the normal policy path.
    this.docs.push(...(reply.result?.content ?? []).filter(c => c.type === 'text' && /(?:^|\n)#{1,6} /.test(c.text)));
  }

  attach(msg) {
    if (!this.docs.length || !Array.isArray(msg.result?.content)) return;
    msg.result.content = [...this.docs.splice(0), ...msg.result.content];
  }

  cancel() {
    this.state = 'cancelled';
    this.abort?.();
    this.docs = [];
    for (const msg of this.waiting.splice(0)) this.refuse(msg);
  }
}

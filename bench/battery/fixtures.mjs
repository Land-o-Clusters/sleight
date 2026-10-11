import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeDocument, checkDocument, fileHash } from './documents.mjs';

export function stateReadCode(bundle) {
  return `var batteryApp = await cua.getApp(${JSON.stringify(bundle)});`;
}
export function checkAnswer(kind, ctx, answer) {
  if (kind === 'app-state') return typeof ctx.state === 'string' && ctx.state.includes(ctx.marker) || 'STATE_MARKER_NOT_OBSERVED';
  let out; try { out = JSON.parse(answer.trim().replace(/^```json\s*|\s*```$/g, '')); } catch { return 'ANSWER_NOT_JSON'; }
  if (out?.marker !== ctx.marker) return 'ANSWER_MARKER_MISMATCH';
  if (kind === 'self-message' && (typeof out.sender !== 'string' || !out.sender.trim() ||
    typeof out.time !== 'string' || !out.time.trim())) return 'MESSAGE_METADATA_MISSING';
  return true;
}
export async function setupFixture(task, ctx) {
  if (task.fixtureKind === 'doc-file') {
    ctx.path = join(ctx.dir, `fixture.${task.format}`); ctx.format = task.format; ctx.mode = task.mode;
    writeDocument(ctx.path, ctx.format, ctx.marker); ctx.beforeHash = fileHash(ctx.path);
    ctx.target = ctx.path;
  } else if (task.fixtureKind === 'web-page') {
    let served = false;
    const server = createServer((req, res) => {
      if (req.method !== 'GET' || req.url !== '/fixture') { res.writeHead(404).end(); return; }
      served = true;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><title>Battery fixture</title><h1>Read this marker</h1><p>${ctx.marker}</p>`);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    ctx.target = `http://127.0.0.1:${server.address().port}/fixture`;
    ctx.pageServed = () => served;
    ctx.closeServer = () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}
export async function checkFixture(task, ctx, answer, { readState } = {}) {
  if (task.checkKind === 'doc-file') return checkDocument(ctx, answer);
  if (task.checkKind === 'web-page' && !ctx.pageServed?.()) return 'PAGE_NOT_SERVED';
  if (task.checkKind === 'app-state') ctx.state = await readState(task.bundle);
  return checkAnswer(task.checkKind, ctx, answer);
}
export const targetURL = target => target?.startsWith('/') ? pathToFileURL(target).href : target;

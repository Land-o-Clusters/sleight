import ts from 'typescript';
import { BENCH_APPS, REAL_APPS } from '../tasks.mjs';
import { answer } from '../fowl/origin-hook.mjs';

const apps = new Set([...BENCH_APPS, ...REAL_APPS]);
export const assertApp = app => {
  if (typeof app !== 'string' || !apps.has(app)) throw Error(`Replay app outside benchmark allowlist: ${app}`);
};

function assertURL(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('Replay URL outside benchmark allowlist'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !(['https://en.wikipedia.org', 'https://developer.mozilla.org'].includes(url.origin) ||
        url.protocol === 'http:' && url.hostname === '127.0.0.1' && answer({ mcp_server_name: 'plugin:sleight:computer', message: `Allow Browser use to access ${url.origin}?` }) === 'accept'))
    throw Error(`Replay URL outside benchmark allowlist: ${url.origin}`);
}
function assertURLs(value) {
  for (const match of value.matchAll(/\b(?:[a-z][a-z\d+.-]*:\/\/|https?:|javascript:|data:)[^\s"'<>`)]*/gi)) assertURL(match[0]);
}

export function assertReplayArguments(args) {
  const walk = (value, key) => {
    if (['app', 'appId', 'bundleId', 'bundleIdentifier'].includes(key)) assertApp(value);
    if (['url', 'origin', 'href'].includes(key)) assertURL(value);
    if (key === 'code' && typeof value === 'string') {
      const ast = ts.createSourceFile('allowlist.js', value, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const visit = node => {
        if (ts.isPropertyAssignment(node) && ['url', 'origin', 'href'].includes(node.name?.text)) {
          if (!ts.isStringLiteral(node.initializer)) throw Error('Computed URL selector cannot be checked against benchmark allowlist');
          assertURL(node.initializer.text);
        }
        if (ts.isStringLiteralLike(node)) {
          assertURLs(node.text);
          if (/^(?:com|org|net|io)\.[\w.-]+$/.test(node.text)) assertApp(node.text);
        }
        const method = ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text :
          ts.isElementAccessExpression(node.expression) && ts.isStringLiteral(node.expression.argumentExpression) ? node.expression.argumentExpression.text : undefined);
        if (method === 'getApp') {
          const arg = node.arguments[0];
          if (arg && ts.isStringLiteral(arg)) assertApp(arg.text);
          else if (arg && ts.isObjectLiteralExpression(arg)) {
            const selectors = arg.properties.filter(p => ['app', 'appId', 'bundleId', 'bundleIdentifier'].includes(p.name?.text));
            if (!selectors.length || selectors.some(p => !ts.isPropertyAssignment(p) || !ts.isStringLiteral(p.initializer)))
              throw Error('Computed app selector cannot be checked against benchmark allowlist');
            selectors.forEach(p => assertApp(p.initializer.text));
          } else throw Error('Computed app selector cannot be checked against benchmark allowlist');
        }
        if (['getTab', 'createBrowserTab', 'goto', 'navigate'].includes(method) && node.arguments.some(arg => !ts.isStringLiteral(arg) && !ts.isObjectLiteralExpression(arg)))
          throw Error('Computed URL selector cannot be checked against benchmark allowlist');
        ts.forEachChild(node, visit);
      };
      visit(ast);
    } else if (typeof value === 'string') assertURLs(value);
    else if (Array.isArray(value)) value.forEach(v => walk(v));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => walk(v, k));
  };
  walk(args);
}

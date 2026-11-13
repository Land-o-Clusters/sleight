// Offline data inspection only. Never imports a runner or starts a child, engine or app.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const values = flag => args.flatMap((arg, i) => arg === flag ? [args[i + 1]] : []);
const [repo] = values('--repo'), [out] = values('--out');
if (!repo || !out) throw Error('Required: --repo ROOT --out FILE [--race ROOT ...]');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bump = (map, key) => { map[key] = (map[key] ?? 0) + 1; };
const root = text => /^Window: /m.test(text) && /^\d+ standard window\b/m.test(text);
const keys = obj => Object.keys(obj ?? {}).sort().join(',');
const paths = (obj, prefix = '') => Object.entries(obj ?? {}).flatMap(([key, value]) => {
  const path = prefix + key;
  return value && typeof value === 'object' && !Array.isArray(value) ? paths(value, path + '.') : [path];
}).sort().join(',');
function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(entry.name) || entry.isSymbolicLink()) continue;
    const file = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(file);
    else if (entry.isFile() && /\.(?:jsonl?|txt)$/.test(file) && statSync(file).size <= 60e6) yield file;
  }
}
function corpus(label, roots) {
  const replies = new Map(), texts = new Map(), counts = { files: 0, jsonRecords: 0, invalidRecords: 0 };
  const reply = (content, meta, code, origin) => {
    const textItems = content.filter(c => c?.type === 'text' && typeof c.text === 'string');
    const trees = textItems.filter(c => root(c.text));
    if (!trees.length) return;
    const id = digest({ content, meta });
    if (!replies.has(id)) replies.set(id, { content, meta, code, origin });
    for (const { text } of trees) if (!texts.has(text)) texts.set(text, origin);
  };
  for (const [index, dir] of roots.entries()) for (const file of files(dir)) {
    counts.files++;
    if (file.endsWith('.txt')) continue; // Plain text has no surviving content-item or metadata boundary.
    const calls = new Map();
    function visit(value, origin, code) {
      if (Array.isArray(value)) {
        reply(value, undefined, code, origin);
        for (const child of value) visit(child, origin, code);
      } else if (value && typeof value === 'object') {
        if (Array.isArray(value.content)) {
          reply(value.content, value._meta, code, origin);
          // Do not also count this array without its enclosing metadata.
          for (const child of value.content) visit(child, origin, code);
        }
        for (const [key, child] of Object.entries(value)) if (key !== 'content') visit(child, origin, code);
      }
    }
    const record = (value, origin) => {
      for (const item of value.message?.content ?? []) {
        if (item.type === 'tool_use') calls.set(item.id, { name: item.name, code: item.input?.code });
      }
      if (value.type === 'item.started' && value.item?.type === 'mcp_tool_call') calls.set(value.item.id,
        { name: value.item.tool, code: value.item.arguments?.code });
      const resultItem = value.message?.content?.find(c => c.type === 'tool_result');
      const call = calls.get(resultItem?.tool_use_id ?? value.item?.id);
    if (Array.isArray(value.tool_use_result?.content)) {
        reply(value.tool_use_result.content, value.tool_use_result._meta, call, origin + '#tool_use_result');
        // The host's message also serializes this result, sometimes without metadata. Count the fuller copy once.
        return;
      }
      visit(value, origin, call);
    };
    if (file.endsWith('.jsonl')) {
      let line = 0;
      for (const raw of readFileSync(file, 'utf8').split('\n')) {
        line++; if (!raw.trim()) continue;
        let value;
        try { value = JSON.parse(raw); } catch { counts.invalidRecords++; continue; }
        counts.jsonRecords++; record(value, `${label}/${index}/${relative(dir, file)}:${line}`);
      }
    } else {
      let value;
      try { value = JSON.parse(readFileSync(file, 'utf8')); } catch { counts.invalidRecords++; continue; }
      counts.jsonRecords++; record(value, `${label}/${index}/${relative(dir, file)}`);
    }
  }
  const itemKeys = {}, resultMetaPaths = {}, itemMetaPaths = {}, imageMetaPaths = {}, layouts = {}, codeClasses = {}, examples = {};
  const distinctTrees = { all: texts.size, browsers: {} };
  for (const text of texts.keys()) {
    const app = /App: ([^\n]+?)\.?\r?$/m.exec(text)?.[1] ?? 'unknown';
    const browser = /Firefox/i.test(app) ? 'Firefox' : /Safari/i.test(app) ? 'Safari' : /Chrome|Chromium|Helium/i.test(app) ? 'Chrome-like' : 'other';
    const group = distinctTrees.browsers[browser] ??= { fullTrees: 0, withArea: 0, withCapitalizedArea: 0, withWindowURL: 0, withWindowURLAndArea: 0 };
    group.fullTrees++;
    const area = /^(\t*)\d+ HTML content\b/m.test(text);
    const windowURL = /^URL: https?:\/\//m.test(text) || /^\d+ standard window.*URL: https?:\/\//m.test(text);
    if (area) group.withArea++;
    if (/^(\t*)\d+ HTML Content\b/m.test(text)) group.withCapitalizedArea++;
    if (windowURL) group.withWindowURL++;
    if (area && windowURL) group.withWindowURLAndArea++;
  }
  counts.distinctReplies = replies.size;
  counts.withImages = 0; counts.withMultipleTextItems = 0; counts.withResultMeta = 0; counts.treeItems = 0;
  counts.treeWithPrefixInModelWrite = 0; counts.treeWithScreenshotBytesPrefix = 0;
  for (const { content, meta, code: call, origin } of replies.values()) {
    if (content.some(c => c.type === 'image')) counts.withImages++;
    if (content.filter(c => c.type === 'text').length > 1) counts.withMultipleTextItems++;
    if (meta) counts.withResultMeta++;
    bump(resultMetaPaths, paths(meta) || '(absent)');
    bump(layouts, content.map(c => c.type === 'text' ? root(c.text ?? '') ? 'tree' : 'text' : c.type).join(','));
    for (const item of content.filter(c => c.type === 'image')) bump(imageMetaPaths, paths(item._meta) || '(absent)');
    for (const item of content.filter(c => c.type === 'text' && root(c.text ?? ''))) {
      counts.treeItems++; bump(itemKeys, keys(item)); bump(itemMetaPaths, paths(item._meta) || '(absent)');
      if (/nodeRepl\.write\s*\(/.test(call?.code ?? '') && item.text.search(/^Window: /m) > 0) counts.treeWithPrefixInModelWrite++;
      if (/^screenshot bytes: \d+\nWindow: /m.test(item.text)) counts.treeWithScreenshotBytesPrefix++;
    }
    const code = call?.code;
    const kind = typeof code !== 'string' ? 'unpaired' : /nodeRepl\.write\s*\(/.test(code) ? 'model-write' : 'no-model-write';
    bump(codeClasses, kind);
    const exampleKey = kind + (content.some(c => c.type === 'image') ? '-image' : '');
    if (!examples[exampleKey]) examples[exampleKey] = { origin, call,
      metaPaths: paths(meta), items: content.map(c => ({ type: c.type, keys: keys(c), prefix: c.text?.slice(0, 140) })) };
  }
  return { label, counts, distinctTrees, itemKeys, itemMetaPaths, imageMetaPaths, resultMetaPaths, layouts, codeClasses, examples };
}
const result = { corpora: [corpus('repo', [join(resolve(repo), 'tests/fixtures'), join(resolve(repo), 'bench/replay')]),
  corpus('race', values('--race'))] };
writeFileSync(out, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
for (const { examples, layouts, ...summary } of result.corpora) console.log(JSON.stringify(summary));

// Read and render the real installed bundle offline. Never import its service.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { MODULES_REL } from '../../plugins/sleight/lib/setup.mjs';

export function installedBrowserRenderer(app = process.env.SLEIGHT_CHATGPT_APP || '/Applications/ChatGPT.app') {
  const root = join(app, MODULES_REL, '@oai/browser-desktop');
  const source = readFileSync(join(root, 'scripts/browser-service.mjs'), 'utf8');
  // Independent oracle: execute only the installed pure document renderer in an
  // empty VM, with fixture browser metadata and file reads. No service is imported.
  const counter = /id:String\((\w+)\+\+\)/.exec(source)?.[1];
  assert.ok(counter && new RegExp(`\\b${counter}=1[,;]`).test(source), 'installed IDs start at 1 and increment');
  assert.match(source, /id:"dot",name:"Dot",type:"iab"/);
  const selectedAt = source.indexOf('"# Selected Browser"');
  const classAt = source.lastIndexOf('var ', selectedAt);
  const className = /var (\w+)=class/.exec(source.slice(classAt))?.[1];
  const classText = source.slice(classAt, selectedAt);
  const support = /new Set\((\w+)\(\{apiManifest:r,browserInfo:t/.exec(classText)?.[1];
  const start = source.indexOf(`function ${support}({apiManifest:e,browserInfo:t,disabledMemberIds:r})`);
  const capAt = source.indexOf('let r=e==="browser"?', selectedAt);
  const end = source.indexOf('}c();function ', capAt) + 1;
  const globals = /let r=e==="browser"\?(\w+):(\w+),/.exec(source.slice(capAt));
  assert.ok(start > 0 && end > start && className && globals);
  const infos = new Map([...source.matchAll(/\{id:"([A-Za-z]+)",description:"((?:\\.|[^"\\])*)"\}/g)].map(m => [m[1], JSON.parse(`"${m[2]}"`)]));
  const caps = ids => ids.map(id => ({ id, info: { description: infos.get(id) } }));
  const Renderer = runInNewContext(source.slice(start, end) + `;${className}`, { c() {}, [globals[1]]: caps(['management', 'visibility', 'viewport']), [globals[2]]: caps(['cdp', 'botDetection', 'browserAuth', 'pageAssets', 'webmcp']) }, { timeout: 1000 });
  const dir = join(root, 'environment-docs/codex-app');
  const renderer = new Renderer({ apiManifest: JSON.parse(readFileSync(join(dir, 'api.json'), 'utf8')),
    documentManifest: JSON.parse(readFileSync(join(dir, 'documents.json'), 'utf8')),
    disabledMemberIds: new Set(), undocumentedApiMembers: ['Tab.ax'],
    excludedDocumentation: ['confirmations', 'tab-claiming-chrome', 'tab-mentions-iab'],
    readDocumentation: name => readFileSync(join(dir, `${name}.md`), 'utf8') });
  return renderer;
}

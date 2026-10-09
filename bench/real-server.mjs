import { createServer } from 'node:http';
import { isDeepStrictEqual } from 'node:util';

const shell = (title, body) => `<!doctype html><meta name="viewport" content="width=device-width"><title>${title}</title>
<style>body{font:20px system-ui;max-width:540px;margin:32px auto;padding:16px}label{display:block;margin:20px 0}input,select,button{font:inherit}input[type=text],input[type=email]{width:95%}button,a{display:inline-block;padding:12px}</style>${body}`;

// Each run has a loopback server and its own nonce. The check reads this
// process's records; none of the page's success messages count as proof.
export async function serveRealPage(ctx, flow = false) {
  const state = { received: [], events: [], value: '' };
  const prefix = `/${ctx.nonce}/`;
  const server = createServer((req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (!route.startsWith(prefix)) { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 8192) req.destroy();
    });
    req.on('end', () => {
      const fields = Object.fromEntries(new URLSearchParams(body));
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      if (!flow) {
        if (req.method === 'POST' && route === prefix) {
          state.received.push(fields);
          res.end(shell(`Form ${ctx.nonce}`, '<h1>Submitted</h1>'));
        } else if (req.method === 'GET' && route === prefix) {
          res.end(shell(`Form ${ctx.nonce}`, `<h1>Project signup</h1><form method="post">
<label>Name <input name="name" type="text" autocomplete="off"></label>
<label>Email <input name="email" type="email" autocomplete="off"></label>
<label>Team <select name="team"><option>Engineering</option><option>Design</option><option>Operations</option></select></label>
<label><input name="updates" type="checkbox" value="yes"> Send updates</label>
<label>Code <input name="code" type="text" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false"></label>
<button>Submit</button></form>`));
        } else res.writeHead(404).end();
        return;
      }
      const screen = route.slice(prefix.length);
      if (req.method === 'GET' && (screen === '' || screen === 'home')) {
        state.events.push('home');
        // Only the exact fixture value is rendered, so arbitrary POST input
        // cannot become HTML. The check still compares the original value.
        const visible = state.value === `Flow ${ctx.nonce}` ? state.value : 'Not set';
        res.end(shell(`Flow ${ctx.nonce}`, `<h1>Profile</h1><p>Saved value: <strong>${visible}</strong></p><a href="${prefix}edit">Edit profile</a>`));
      } else if (req.method === 'GET' && screen === 'edit') {
        state.events.push('edit');
        res.end(shell(`Flow ${ctx.nonce}`, `<h1>Edit profile</h1><form method="post" action="${prefix}save"><label>Value <input name="value" type="text" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false"></label><button>Save</button></form>`));
      } else if (req.method === 'POST' && screen === 'save') {
        state.events.push('save');
        state.value = fields.value ?? '';
        res.end(shell(`Flow ${ctx.nonce}`, `<h1>Saved</h1><a href="${prefix}home">Back to profile</a>`));
      } else res.writeHead(404).end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  ctx.page = state;
  ctx.url = `http://127.0.0.1:${server.address().port}${prefix}`;
  ctx.closeServer = () => new Promise((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
    server.closeAllConnections();
  });
}

export function checkForm(ctx) {
  const want = { name: 'Morgan Reed', email: 'morgan@example.test', team: 'Design', updates: 'yes', code: ctx.nonce };
  return ctx.page?.received.some(got => Object.keys(want).every(key => got[key] === want[key]) &&
    Object.keys(got).length === Object.keys(want).length) || 'server has no submission with all five expected values';
}

export function checkFlow(ctx) {
  const events = ctx.page?.events ?? [];
  let stage = 0;
  for (const event of events) if (event === ['edit', 'save', 'home'][stage]) stage++;
  return ctx.page?.value === `Flow ${ctx.nonce}` && stage === 3 && events.at(-1) === 'home' ||
    'server has no saved value ending on the profile screen';
}

const gridRows = [
  ['Oak', 510], ['Orchid', 275], ['Cedar', 90], ['Maple', 180], ['Harbor', 140], ['Pine', 430],
  ['Willow', 220], ['Elm', 350], ['Spruce', 470], ['Juniper', 260], ['Aspen', 390], ['Birch', 310],
].map(([project, budget]) => ({ project, budget }));
const webKinds = ['grid', 'editor', 'dense', 'spa', 'nested', 'infinite'];
const articleTitle = id => id === 'link-173' ? 'Tidal observatory field notes' : `Research bulletin ${id.slice(5)}`;

// The browser reports DOM state to this run's server. Checkers compare that
// state with fixture values, independently of the driver's answer.
export function checkWeb(ctx) {
  const want = {
    grid: { rows: gridRows.map(row => row.project === 'Orchid' ? { ...row, budget: 125 } : row)
      .sort((a, b) => a.budget - b.budget), sorted: 'budget-ascending' },
    editor: { document: [
      { tag: 'h1', children: [{ text: 'Weekly planning', bold: false }] },
      { tag: 'h2', children: [{ text: 'Release checklist', bold: false }] },
      { tag: 'p', children: [{ text: 'We ', bold: false }, { text: 'ship carefully', bold: true }, { text: ' every Friday.', bold: false }] },
      { tag: 'ul', children: ['Review draft', 'Publish release', `Archive notes ${ctx.nonce}`]
        .map(item => ({ tag: 'li', children: [{ text: item, bold: false }] })) },
    ] },
    dense: { selected: 'link-173', title: 'Tidal observatory field notes' },
    spa: { route: '/complete', visits: ['/', '/requests', '/requests/new', '/complete'],
      fields: { category: 'Research', project: 'Orchid', code: ctx.nonce } },
    nested: { accordion: true, tree: ['Science', 'Marine', 'Station'], details: true, selected: `Coral report ${ctx.nonce}` },
    infinite: { loaded: 100, opened: 'Record 87', note: `Reviewed ${ctx.nonce}`, confirmed: true, modalOpen: false },
  }[ctx.webKind];
  return !!want && isDeepStrictEqual(ctx.page?.snapshot, want) &&
    (ctx.webKind !== 'dense' || ctx.page?.articles.at(-1) === 'link-173') ||
    `page state does not match the ${ctx.webKind} task`;
}

function webPage(kind, nonce, prefix, article) {
  const common = `const $ = id => document.getElementById(id);
const text = node => node?.textContent.trim() ?? '';
let sequence = Date.now() * 1000;
const post = state => fetch(${JSON.stringify(prefix + 'state')}, {method:'POST', headers:{'content-type':'application/json'},
  body:JSON.stringify({nonce:${JSON.stringify(nonce)},kind:${JSON.stringify(kind)},sequence:++sequence,state})}).catch(() => {});`;
  let body, script;
  if (kind === 'grid') {
    body = `<h1>Project budgets</h1><p>Find a project, edit its budget, then sort the Budget column.</p>
<label>Find project <input id="find" type="search"></label><button id="find-row">Find row</button>
<table><thead><tr><th>Project</th><th><button id="sort">Sort Budget ascending</button></th></tr></thead><tbody id="rows"></tbody></table>`;
    script = `let rows = ${JSON.stringify(gridRows)}, sorted = '';
const snapshot = () => post({rows, sorted});
function render() { $('rows').replaceChildren(); for (const row of rows) {
  const tr = document.createElement('tr'), name = document.createElement('th'), cell = document.createElement('td'), input = document.createElement('input');
  name.textContent = row.project; input.type = 'number'; input.value = row.budget; input.setAttribute('aria-label', row.project + ' budget');
  input.oninput = () => { row.budget = Number(input.value); sorted = ''; snapshot(); };
  cell.append(input); tr.append(name, cell); $('rows').append(tr);
} }
$('find-row').onclick = () => { const index = rows.findIndex(row => row.project.toLowerCase() === $('find').value.trim().toLowerCase());
  if (index >= 0) $('rows').children[index].querySelector('input').focus(); };
$('sort').onclick = () => { rows.sort((a,b) => a.budget-b.budget); sorted = 'budget-ascending'; render(); snapshot(); };
render(); snapshot();`;
  } else if (kind === 'editor') {
    body = `<h1>Planning document</h1><p>Edit the document below. Select a phrase and use Bold, or use the keyboard shortcut.</p>
<button id="bold" type="button">Bold</button><article id="editor" contenteditable="true" aria-label="Planning document">
<h1>Weekly planning</h1><h2>Release checklist</h2><p>We ship carefully every Friday.</p><ul><li>Review draft</li><li>Publish release</li></ul></article>`;
    script = `const editor = $('editor');
function content(node, bold = false) {
  const result = [], container = node === editor || ['UL','OL'].includes(node.tagName);
  for (const child of node.childNodes) {
    let entries;
    if (child.nodeType === 3) entries = !child.data || (container && !child.data.trim()) ? [] : [{text:child.data,bold}];
    else if (child.nodeType === 1) {
      const tag = child.tagName.toLowerCase(), weight = child.style.fontWeight;
      let marked = ['b','strong'].includes(tag) || bold;
      if (weight) marked = ['bold','bolder'].includes(weight) || Number(weight) >= 600;
      const children = content(child, marked);
      entries = ['b','strong','span'].includes(tag) ? children : [{tag,children}];
    } else entries = [{tag:'#'+child.nodeType}];
    for (const entry of entries) {
      const previous = result.at(-1);
      if ('text' in entry && previous && 'text' in previous && previous.bold === entry.bold) previous.text += entry.text;
      else result.push(entry);
    }
  }
  return result;
}
const snapshot = () => post({document:content(editor)});
$('bold').onmousedown = event => event.preventDefault();
$('bold').onclick = () => { document.execCommand('bold'); snapshot(); };
editor.addEventListener('input', snapshot); new MutationObserver(snapshot).observe(editor,{subtree:true,childList:true,characterData:true,attributes:true}); snapshot();`;
  } else if (kind === 'dense') {
    if (article) {
      body = `<h1 id="article-title">${articleTitle(article)}</h1><p>Field notes for the coastal research archive.</p><a href="${prefix}">Back to archive</a>`;
      script = `post({selected:${JSON.stringify(article)},title:text($('article-title'))});`;
    } else {
      body = '<h1>Research archive</h1><p>240 bulletins and field notes. Open the article named in your task.</p><nav>' +
        Array.from({ length: 240 }, (_, i) => `<p><a href="${prefix}article/link-${i + 1}">${articleTitle(`link-${i + 1}`)}</a></p>`).join('') + '</nav>';
      script = `post({selected:'',title:''});`;
    }
  } else if (kind === 'spa') {
    body = '<h1>Research requests</h1><main id="screen"></main>';
    script = `let route = '/', visits = ['/'], fields = {category:'',project:'',code:''};
const snapshot = () => post({route,visits,fields});
function go(next) { route = next; visits.push(next); history.pushState({},'',${JSON.stringify(prefix)}+'#'+next); render(); snapshot(); }
function render() {
  if (route === '/') { $('screen').innerHTML = '<button id="requests">Requests</button>'; $('requests').onclick = () => go('/requests'); }
  else if (route === '/requests') { $('screen').innerHTML = '<h2>Requests</h2><button id="new">New request</button>'; $('new').onclick = () => go('/requests/new'); }
  else if (route === '/requests/new') {
    $('screen').innerHTML = '<h2>New request</h2><form id="form"><label>Category <select id="category"><option value="">Choose category</option><option>Research</option><option>Operations</option></select></label><div id="project-step"></div></form>';
    $('category').onchange = () => { fields.category = $('category').value; fields.project = ''; fields.code = '';
      $('project-step').innerHTML = '<label>Project <input id="project" type="text" autocomplete="off"></label><button id="continue" type="button">Continue</button><div id="code-step"></div>';
      $('project').oninput = () => { fields.project = $('project').value; snapshot(); };
      $('continue').onclick = () => { if (!fields.project.trim()) return;
        $('code-step').innerHTML = '<label>Code <input id="code" type="text" autocomplete="off" autocorrect="off" spellcheck="false"></label><button>Submit request</button>';
        $('code').oninput = () => { fields.code = $('code').value; snapshot(); }; snapshot(); }; snapshot(); };
    $('form').onsubmit = event => { event.preventDefault(); if (fields.category && fields.project && fields.code) go('/complete'); };
  } else $('screen').innerHTML = '<h2>Request submitted</h2>';
}
addEventListener('popstate', () => { route = location.hash.slice(1) || '/'; visits.push(route); render(); snapshot(); }); render(); snapshot();`;
  } else if (kind === 'nested') {
    body = `<h1>Research library</h1><button id="accordion" aria-expanded="false">Collections</button><section id="collection" hidden>
<div role="tree" aria-label="Research collections"><details id="science" role="treeitem" aria-expanded="false"><summary>Science</summary><div role="group"><details id="marine" role="treeitem" aria-expanded="false"><summary>Marine</summary>
<div role="group"><details id="station" role="treeitem" aria-expanded="false"><summary>Station</summary><details id="reports"><summary>Reports</summary>
<button id="coral">Coral report ${nonce}</button><button id="weather">Weather report</button></details></details></div></details></div></details></div></section><p id="selected"></p>`;
    script = `const snapshot = () => post({accordion:!$('collection').hidden,tree:['science','marine','station'].filter(id => $(id).open).map(id => ({science:'Science',marine:'Marine',station:'Station'})[id]),details:$('reports').open,selected:text($('selected'))});
$('accordion').onclick = () => { $('collection').hidden = !$('collection').hidden; $('accordion').setAttribute('aria-expanded',String(!$('collection').hidden)); snapshot(); };
for (const id of ['science','marine','station','reports']) $(id).addEventListener('toggle',() => { if (id !== 'reports') $(id).setAttribute('aria-expanded',String($(id).open)); snapshot(); });
for (const id of ['coral','weather']) $(id).onclick = () => { $('selected').textContent = text($(id)); snapshot(); }; snapshot();`;
  } else {
    body = `<h1>Inspection records</h1><p>Scroll to load more records. Open a record to review it.</p><div id="records"></div><p id="sentinel">Loading records…</p>
<dialog id="modal" aria-labelledby="modal-title"><h2 id="modal-title"></h2><form id="review"><label>Review note <input id="note" type="text" autocomplete="off" autocorrect="off" spellcheck="false"></label>
<button>Confirm review</button><button id="cancel" type="button">Cancel</button></form></dialog><p id="result"></p>`;
    script = `let loaded = 0, opened = '', note = '', confirmed = false;
const snapshot = () => post({loaded,opened,note,confirmed,modalOpen:$('modal').open});
function more() { const end = Math.min(loaded+20,100); for (let n=loaded+1;n<=end;n++) {
  const p = document.createElement('p'), button = document.createElement('button'); button.textContent = 'Record '+n;
  button.onclick = () => { opened = button.textContent; note = ''; confirmed = false; $('note').value = ''; $('modal-title').textContent = opened; $('modal').showModal(); snapshot(); };
  p.append(button); $('records').append(p); } loaded = end; if (loaded === 100) $('sentinel').textContent = 'All records loaded'; snapshot(); }
new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting) && loaded < 100) more(); }).observe($('sentinel'));
$('note').oninput = () => { note = $('note').value; snapshot(); };
$('review').onsubmit = event => { event.preventDefault(); confirmed = true; note = $('note').value; $('modal').close(); $('result').textContent = opened+' reviewed'; snapshot(); };
$('cancel').onclick = () => { $('modal').close(); snapshot(); }; $('modal').addEventListener('close',snapshot); more();`;
  }
  return shell(`${kind} ${nonce}`, body + `<style>body{max-width:820px}table{border-collapse:collapse;width:100%}th,td{padding:8px;text-align:left}td input{width:140px}article{padding:16px;border:1px solid #888}details{padding:12px 20px}dialog{max-width:500px}button{margin:4px}</style><script>${common}\n${script}</script>`);
}

export async function serveWebPage(ctx, kind) {
  if (!webKinds.includes(kind) || !/^[A-Za-z0-9_-]{1,80}$/.test(ctx.nonce)) throw new Error('invalid web fixture kind or nonce');
  if (ctx.closeServer) throw new Error('web fixture server already exists');
  const prefix = `/${ctx.nonce}/`, page = { snapshot: undefined, sequence: -1, articles: [] };
  let origin;
  const server = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const route = new URL(req.url, 'http://localhost').pathname;
    if (req.headers.host !== origin?.slice(7) || !route.startsWith(prefix)) { res.writeHead(404).end(); return; }
    if (req.headers.origin && req.headers.origin !== origin) { res.writeHead(403).end(); return; }
    if (req.method === 'POST' && route === prefix + 'state') {
      if (req.headers['content-type'] !== 'application/json') { res.writeHead(400).end(); req.resume(); return; }
      let body = '', size = 0, tooLarge = false;
      req.on('data', chunk => { size += chunk.length; if (size > 32768) { if (!tooLarge) res.writeHead(413).end(); tooLarge = true; } else body += chunk; });
      req.on('end', () => {
        if (tooLarge) return;
        let payload; try { payload = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
        if (!payload || payload.nonce !== ctx.nonce || payload.kind !== kind || !Number.isSafeInteger(payload.sequence) ||
          payload.sequence < 0 || !payload.state || typeof payload.state !== 'object' || Array.isArray(payload.state)) { res.writeHead(400).end(); return; }
        if (payload.sequence > page.sequence) { page.sequence = payload.sequence; page.snapshot = payload.state; }
        res.writeHead(204).end();
      });
      return;
    }
    if (req.method !== 'GET') { res.writeHead(404).end(); return; }
    const article = route.slice(prefix.length).match(/^article\/(link-(?:[1-9]|[1-9]\d|1\d\d|2[0-3]\d|240))$/)?.[1];
    if (route !== prefix && !(kind === 'dense' && article)) { res.writeHead(404).end(); return; }
    if (article) page.articles.push(article);
    res.end(webPage(kind, ctx.nonce, prefix, article));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  ctx.page = page; ctx.webKind = kind; ctx.url = origin + prefix;
  let closing;
  ctx.closeServer = () => closing ??= new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  });
}

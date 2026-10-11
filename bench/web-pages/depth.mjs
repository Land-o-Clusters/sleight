export const depthKinds = ['validation', 'controls', 'modal', 'hover', 'reorder', 'iframe', 'shadow', 'tabs', 'accordion', 'delayed'];

export function depthExpected(kind, nonce) {
  return {
    validation: { rejected: true, errors: [], fields: { email: 'team@example.test', seats: '3', code: nonce }, submitted: true },
    controls: { project: 'Orchid', date: '2026-11-17', team: 'Research', submitted: true },
    modal: { project: 'Orchid', note: `Approved ${nonce}`, confirmed: true, modalOpen: false },
    hover: { row: 'Orchid', action: 'Archive', menuOpen: false },
    reorder: { order: ['Oak', 'Cedar', 'Maple', 'Orchid', 'Pine'] },
    iframe: { outside: '', frame: { project: 'Orchid', code: nonce, submitted: true } },
    shadow: { outside: '', inside: { project: 'Orchid', code: nonce, submitted: true } },
    tabs: { tab: 'first', answer: `Tide-${nonce}`, submitted: true },
    accordion: { expanded: ['Marine'], answer: `Coral-${nonce}`, submitted: true },
    delayed: { loaded: true, answer: `Ready-${nonce}`, submitted: true },
  }[kind];
}

const input = (id, label, value = '') => `<label>${label} <input id="${id}" type="text" value="${value}" autocomplete="off" autocorrect="off" spellcheck="false"></label>`;
const projectForm = `<form id="form"><label>Project <select id="project"><option>Oak</option><option>Orchid</option></select></label>${input('code', 'Code')}<button>Submit project</button></form><p id="result" role="status"></p>`;

// These pages report their controls' state. They use no browser-specific API.
export function depthPage(kind, nonce, prefix, section) {
  if (!depthKinds.includes(kind)) return undefined;
  let body = '', script = '';
  const endpoint = section ? `${section}/state` : 'state';
  const common = `const $ = id => document.getElementById(id);
let sequence = Date.now() * 1000;
const post = state => fetch(${JSON.stringify(prefix + endpoint)}, {method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({nonce:${JSON.stringify(nonce)},kind:${JSON.stringify(kind)},sequence:++sequence,state})}).catch(() => {});`;

  if (kind === 'validation') {
    body = `<h1>Team registration</h1><p>Submit the draft to see its errors, then correct them.</p><form id="form" novalidate>
${input('email', 'Email', 'team.example.test')}<label>Seats <input id="seats" type="number" value="0"></label>${input('code', 'Code')}
<ul id="errors" role="alert"></ul><button>Submit registration</button></form><p id="result" role="status"></p>`;
    script = `let rejected = false, errors = [], submitted = false;
const fields = () => ({email:$('email').value,seats:$('seats').value,code:$('code').value});
const snapshot = () => post({rejected,errors,fields:fields(),submitted});
for (const id of ['email','seats','code']) $(id).oninput = () => { submitted = false; snapshot(); };
$('form').onsubmit = event => { event.preventDefault(); errors = [];
  if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test($('email').value)) errors.push('Email is invalid');
  if (!Number.isInteger(Number($('seats').value)) || Number($('seats').value) < 1) errors.push('Seats must be a positive whole number');
  if (!$('code').value.trim()) errors.push('Code is required');
  rejected ||= errors.length > 0; submitted = errors.length === 0;
  $('errors').replaceChildren(...errors.map(error => { const li = document.createElement('li'); li.textContent = error; return li; }));
  $('result').textContent = submitted ? 'Registration submitted' : ''; snapshot(); }; snapshot();`;
  } else if (kind === 'controls') {
    body = `<h1>Schedule research</h1><form id="form"><label>Project <input id="project" role="combobox" aria-autocomplete="list" aria-controls="options" aria-expanded="false" autocomplete="off"></label>
<ul id="options" role="listbox" hidden><li><button id="oak" role="option" type="button">Oak</button></li><li><button id="orchid" role="option" type="button">Orchid</button></li></ul>
<label>Visit date <input id="date" type="date"></label><label>Team <select id="team"><option>Operations</option><option>Research</option><option>Design</option></select></label><button>Save schedule</button></form><p id="result" role="status"></p>`;
    script = `let submitted = false;
const snapshot = () => post({project:$('project').value,date:$('date').value,team:$('team').value,submitted});
const expand = visible => { $('options').hidden = !visible; $('project').setAttribute('aria-expanded',String(visible)); };
$('project').onfocus = () => expand(true);
for (const id of ['project','date','team']) { $(id).oninput = () => { submitted = false; if (id === 'project') expand(true); snapshot(); }; $(id).onchange = () => { submitted = false; snapshot(); }; }
for (const id of ['oak','orchid']) $(id).onclick = () => { $('project').value = $(id).textContent; expand(false); submitted = false; snapshot(); };
$('project').onkeydown = event => { if (event.key === 'Escape') expand(false); if (event.key === 'ArrowDown') { event.preventDefault(); expand(true); $('oak').focus(); } };
$('form').onsubmit = event => { event.preventDefault(); submitted = true; $('result').textContent = 'Schedule saved'; snapshot(); }; snapshot();`;
  } else if (kind === 'modal') {
    body = `<h1>Project approvals</h1><button id="oak">Review Oak</button><button id="orchid">Review Orchid</button>
<dialog id="modal" aria-labelledby="title"><h2 id="title"></h2><form id="form">${input('note', 'Approval note')}<button>Confirm approval</button><button id="cancel" type="button">Cancel</button></form></dialog><p id="result" role="status"></p>`;
    script = `let project = '', confirmed = false;
const snapshot = () => post({project,note:$('note').value,confirmed,modalOpen:$('modal').open});
for (const id of ['oak','orchid']) $(id).onclick = () => { project = $(id).textContent.slice(7); confirmed = false; $('note').value = ''; $('title').textContent = project; $('modal').showModal(); snapshot(); };
$('note').oninput = snapshot;
$('form').onsubmit = event => { event.preventDefault(); confirmed = true; $('modal').close(); $('result').textContent = project+' approved'; snapshot(); };
$('cancel').onclick = () => $('modal').close(); $('modal').addEventListener('close',snapshot); snapshot();`;
  } else if (kind === 'hover') {
    body = `<h1>Project actions</h1><p>Hover over a project's Actions area to reveal its menu.</p><ul>` + ['Oak', 'Orchid', 'Cedar'].map(name =>
      `<li class="row" id="row-${name}">${name}<span id="actions-${name}" tabindex="0" aria-label="${name} Actions"> Actions
<span id="menu-${name}" role="menu" hidden><button id="archive-${name}" role="menuitem">Archive</button><button id="pin-${name}" role="menuitem">Pin</button></span></span></li>`).join('') + '</ul><p id="result" role="status"></p>';
    script = `let row = '', action = '';
const names = ['Oak','Orchid','Cedar'];
const snapshot = () => post({row,action,menuOpen:names.some(name => !$('menu-'+name).hidden)});
for (const name of names) {
  const show = visible => { for (const other of names) $('menu-'+other).hidden = other !== name || !visible; snapshot(); };
  $('actions-'+name).onmouseenter = () => show(true); $('actions-'+name).onfocusin = () => show(true);
  $('actions-'+name).onmouseleave = () => show(false);
  for (const choice of ['archive','pin']) $(choice+'-'+name).onclick = () => { row = name; action = choice === 'archive' ? 'Archive' : 'Pin'; show(false); $('result').textContent = row+' '+action; snapshot(); };
} snapshot();`;
  } else if (kind === 'reorder') {
    body = '<h1>Project order</h1><p>Drag a project onto another row to place it at that position.</p><ol id="items"></ol>';
    script = `let order = ['Oak','Orchid','Cedar','Maple','Pine'], dragged;
const snapshot = () => post({order:[...$('items').children].map(item => item.textContent)});
function render() { $('items').replaceChildren(); for (const name of order) {
  const item = document.createElement('li'); item.textContent = name; item.draggable = true; item.setAttribute('aria-label',name+' draggable project');
  item.ondragstart = event => { dragged = name; event.dataTransfer.setData('text/plain',name); event.dataTransfer.effectAllowed = 'move'; };
  item.ondragover = event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; };
  item.ondrop = event => { event.preventDefault(); const from = order.indexOf(dragged), to = order.indexOf(name);
    if (from < 0 || from === to) return; order.splice(from,1); order.splice(to,0,dragged); dragged = undefined; render(); snapshot(); };
  item.ondragend = () => { dragged = undefined; }; $('items').append(item);
} } render(); snapshot();`;
  } else if (kind === 'iframe') {
    if (section === 'frame') {
      body = '<h1>Embedded project form</h1>' + projectForm;
      script = `let submitted = false;
const snapshot = () => { const state = {project:$('project').value,code:$('code').value,submitted}; post(state); parent.postMessage({type:'fixture-frame',state},location.origin); };
for (const id of ['project','code']) { $(id).oninput = () => { submitted = false; snapshot(); }; $(id).onchange = $(id).oninput; }
$('form').onsubmit = event => { event.preventDefault(); submitted = true; $('result').textContent = 'Project submitted'; snapshot(); }; snapshot();`;
    } else {
      body = `<h1>Embedded workspace</h1>${input('outside', 'Outer page code (leave blank)')}<iframe id="frame" title="Project form" src="${prefix}frame" style="width:100%;height:460px"></iframe>`;
      script = `let frame;
const snapshot = () => post({outside:$('outside').value,frame});
addEventListener('message',event => { if (event.origin !== location.origin || event.source !== $('frame').contentWindow || event.data?.type !== 'fixture-frame') return; frame = event.data.state; snapshot(); });
$('outside').oninput = snapshot; snapshot();`;
    }
  } else if (kind === 'shadow') {
    body = `<h1>Component workspace</h1>${input('outside', 'Outer page code (leave blank)')}<section id="host" aria-label="Project component"></section>`;
    script = `const root = $('host').attachShadow({mode:'open'}); root.innerHTML = ${JSON.stringify('<style>label{display:block;margin:20px 0}input,select,button{font:20px system-ui}button{padding:12px}</style><h2>Project component</h2>' + projectForm)};
const inside = id => root.getElementById(id); let submitted = false;
const snapshot = () => post({outside:$('outside').value,inside:{project:inside('project').value,code:inside('code').value,submitted}});
for (const id of ['project','code']) { inside(id).oninput = () => { submitted = false; snapshot(); }; inside(id).onchange = inside(id).oninput; }
$('outside').oninput = snapshot;
inside('form').onsubmit = event => { event.preventDefault(); submitted = true; inside('result').textContent = 'Project submitted'; snapshot(); }; snapshot();`;
  } else if (kind === 'tabs') {
    if (section === 'second') {
      body = `<h1>Reference tab</h1><p>Reference value: <strong>Tide-${nonce}</strong></p><p>Enter this value only on the first tab.</p><form id="form">${input('answer', 'Reference tab answer (leave blank)')}<button>Submit reference answer</button></form><button id="close">Close reference tab</button>`;
      script = `let submitted = false;
const snapshot = () => post({tab:'second',value:${JSON.stringify(`Tide-${nonce}`)},answer:$('answer').value,submitted});
$('answer').oninput = () => { submitted = false; snapshot(); };
$('form').onsubmit = event => { event.preventDefault(); submitted = true; snapshot(); };
$('close').onclick = () => window.close(); snapshot();`;
    } else {
      body = `<h1>First tab</h1><a href="${prefix}second" target="_blank" rel="noopener">Open reference tab</a><form id="form">${input('answer', 'Reference value')}<button>Submit value</button></form><p id="result" role="status"></p>`;
      script = `let submitted = false;
const snapshot = () => post({tab:'first',answer:$('answer').value,submitted});
$('answer').oninput = () => { submitted = false; snapshot(); };
$('form').onsubmit = event => { event.preventDefault(); submitted = true; $('result').textContent = 'Value submitted'; snapshot(); }; snapshot();`;
    }
  } else if (kind === 'accordion') {
    body = `<h1>Station reference</h1><details id="coastal"><summary>Coastal</summary><p>Code: Sand-${nonce}</p></details><details id="marine"><summary>Marine</summary><p>Code: Coral-${nonce}</p></details><details id="forest"><summary>Forest</summary><p>Code: Leaf-${nonce}</p></details><form id="form">${input('answer', 'Marine code')}<button>Submit code</button></form><p id="result" role="status"></p>`;
    script = `let submitted = false;
const snapshot = () => post({expanded:['coastal','marine','forest'].filter(id => $(id).open).map(id => $(id).querySelector('summary').textContent),answer:$('answer').value,submitted});
for (const id of ['coastal','marine','forest']) $(id).addEventListener('toggle',snapshot);
$('answer').oninput = () => { submitted = false; snapshot(); };
$('form').onsubmit = event => { event.preventDefault(); submitted = true; $('result').textContent = 'Code submitted'; snapshot(); }; snapshot();`;
  } else if (kind === 'delayed') {
    const delay = 1000 + [...nonce].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 2001, 0);
    body = `<h1>Pending report</h1><section id="content" aria-live="polite">Loading report...</section><form id="form">${input('answer', 'Report code')}<button>Submit report code</button></form><p id="result" role="status"></p>`;
    script = `let loaded = false, submitted = false;
const snapshot = () => post({loaded,answer:$('answer').value,submitted});
setTimeout(() => { $('content').textContent = ${JSON.stringify(`Report code: Ready-${nonce}`)}; loaded = true; snapshot(); },${delay});
$('answer').oninput = () => { submitted = false; snapshot(); };
$('form').onsubmit = event => { event.preventDefault(); submitted = true; $('result').textContent = 'Report code submitted'; snapshot(); }; snapshot();`;
  }
  return body + `<style>dialog::backdrop{background:#0008}.row{padding:24px;border:1px solid #888;margin:12px}#items li{padding:24px;border:1px solid #888;margin:12px;cursor:grab}details{padding:16px}</style><script>${common}\n${script}</script>`;
}

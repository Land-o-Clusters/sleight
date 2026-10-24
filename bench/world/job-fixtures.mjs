// Independent local tasks derived from the BF1 behavior spec, never from a competitor's site.
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const jobKinds = ['job-canvas', 'job-kanban', 'job-phone', 'job-dark', 'job-motion'];
const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const instructions = {
  'job-canvas': 'Read the six-digit routing code drawn on the canvas. Return JSON with code as a string.',
  'job-kanban': 'Move the card named on the board from Queue into Review by dragging its grip, without opening it. Return JSON with card (the card name) and column (Review).',
  'job-phone': 'Check this page at a phone viewport of 390 by 844 CSS pixels. Without scrolling, is the Reserve button fully visible? Return JSON with width, height and actionVisible (boolean). Restore the original viewport.',
  'job-dark': 'Test this page in dark color scheme. What color is the circular badge: amber, teal or violet? Return JSON with scheme (dark) and badge (the color). Restore the original color scheme.',
  'job-motion': 'Press Play once and inspect the animation as it runs. Report the three colors in order as JSON with phases (an array of color names). The final gray frame is not a phase. Do not enable reduced motion for this test.',
};

export function createJobFixture(kind, { nonce, seed = randomBytes(24).toString('hex') } = {}) {
  if (!jobKinds.includes(kind) || !/^[A-Za-z0-9_-]{1,80}$/.test(nonce ?? '')) throw Error('invalid local job fixture');
  const number = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
  const colors = ['amber', 'teal', 'violet'];
  const phases = colors.map((_, index) => colors[(index + number % 3) % 3]);
  const expected = {
    'job-canvas': { code: String(100000 + number % 900000) },
    'job-kanban': { card: `Parcel ${100 + number % 900}`, column: 'Review' },
    'job-phone': { width: 390, height: 844, actionVisible: false },
    'job-dark': { scheme: 'dark', badge: 'amber' },
    'job-motion': { phases },
  }[kind];
  return { kind, nonce, expected, views: [], events: [] };
}

export function jobTask(fixture, origin, browser) {
  if (!jobKinds.includes(fixture.kind) || !['chrome', 'helium'].includes(browser)) throw Error('invalid job task');
  const url = new URL(origin);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw Error('local job origin required');
  return { name: fixture.kind, browser, budgetSeconds: 180, needsClicks: fixture.kind === 'job-kanban' || fixture.kind === 'job-motion',
    worldFixture: fixture.kind, prompt: `In {browser}, open ${url.origin}/${fixture.nonce}/. ${instructions[fixture.kind]} Use only this fixture.`,
    result: 'only the requested JSON', grade: `${url.origin}/${fixture.nonce}/api/log`, site: { log: `${url.origin}/${fixture.nonce}/api/log` } };
}

function render(fixture) {
  const { kind, nonce, expected } = fixture;
  const eventPath = `/${nonce}/event`;
  let content = '', script = '';
  if (kind === 'job-canvas') {
    content = '<h1>Routing slip</h1><canvas id="slip" width="480" height="160" aria-label="Routing code image"></canvas>';
    script = `const c=document.querySelector('canvas').getContext('2d');c.fillStyle='#e8f0f5';c.fillRect(0,0,480,160);c.fillStyle='#152434';c.font='bold 52px monospace';c.fillText('${expected.code}',90,100);`;
  }
  if (kind === 'job-kanban') {
    content = `<h1>Dispatch board</h1><p>Move ${esc(expected.card)} to Review.</p><div class="board"><section id="queue"><h2>Queue</h2><article id="card"><span id="grip" role="button" aria-label="Drag ${esc(expected.card)}" tabindex="0">⠿</span> ${esc(expected.card)}</article></section><section id="review"><h2>Review</h2></section></div><p id="status">Waiting</p>`;
    script = `const grip=document.querySelector('#grip'),card=document.querySelector('#card'),review=document.querySelector('#review');let drag;
      grip.onpointerdown=e=>{if(e.button!==0)return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,points:0};grip.setPointerCapture(e.pointerId);};
      grip.onpointermove=e=>{if(drag&&e.pointerId===drag.id&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>3)drag.points++;};
      grip.onpointerup=e=>{if(!drag||drag.id!==e.pointerId)return;const r=review.getBoundingClientRect();
        if(drag.points>=3&&e.clientX>r.left&&e.clientX<r.right&&e.clientY>r.top&&e.clientY<r.bottom){review.append(card);document.querySelector('#status').textContent='Moved';emit({kind:'drag',card:${JSON.stringify(expected.card)},from:'Queue',to:'Review',points:drag.points});}drag=null;};
      grip.onpointercancel=()=>{drag=null;};`;
  }
  if (kind === 'job-phone') content = '<h1>Cabin visit</h1><p>Check the booking action on a phone without scrolling.</p><div class="spacer"></div><button id="reserve" type="button">Reserve</button>';
  if (kind === 'job-dark') {
    content = '<h1>Night palette</h1><p>Read the circular badge color in dark mode.</p><canvas id="badge" width="280" height="180" aria-label="Theme badge image"></canvas>';
    script = `const scheme=matchMedia('(prefers-color-scheme: dark)');function paint(){const c=document.querySelector('canvas').getContext('2d');c.clearRect(0,0,280,180);c.fillStyle=scheme.matches?'#ffbf26':'#138d86';c.beginPath();c.arc(140,90,60,0,2*Math.PI);c.fill();}scheme.addEventListener('change',paint);paint();`;
  }
  if (kind === 'job-motion') {
    content = '<h1>Signal preview</h1><button id="play" type="button">Play</button><div id="signal" role="img" aria-label="Animated signal"></div><p id="status">Ready</p>';
    script = `const phases=${JSON.stringify(expected.phases)},palette={amber:'#ffbf26',teal:'#138d86',violet:'#8753d8'},signal=document.querySelector('#signal');let played=false;
      document.querySelector('#play').onclick=()=>{if(played)return;played=true;const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches,seen=[];let start;
        function frame(time){start??=time;const index=Math.floor((time-start)/180);if(index<3){const color=phases[index];signal.style.background=palette[color];signal.style.transform='translateX('+index*70+'px)';if(seen.at(-1)!==color)seen.push(color);requestAnimationFrame(frame);}else{signal.style.background='#777';signal.style.transform='translateX(210px)';document.querySelector('#status').textContent='Finished';emit({kind:'motion',phases:seen,reduced});}}
        if(reduced){signal.style.background='#777';emit({kind:'motion',phases:[],reduced});}else requestAnimationFrame(frame);};`;
  }
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local ${esc(kind)}</title>
    <style>body{font:18px system-ui;margin:24px;color:#142336;background:#fff}button{padding:12px}.board{display:flex;gap:40px}section{width:280px;height:240px;background:#edf2f8;padding:16px}article{padding:20px;background:white}#grip{display:inline-block;cursor:grab;touch-action:none;padding:12px}#signal{width:80px;height:80px;background:#777;margin:40px}.spacer{height:100px}@media(max-width:500px){.spacer{height:850px}}@media(prefers-color-scheme:dark){body{color:#e4eaf2;background:#142336}}</style>
    ${content}<script>
    const emit=event=>fetch('${eventPath}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(event)});
    const media=()=>emit({kind:'media',width:innerWidth,height:innerHeight,scheme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light',reduced:matchMedia('(prefers-reduced-motion: reduce)').matches});
    addEventListener('resize',media);for(const query of ['(prefers-color-scheme: dark)','(prefers-reduced-motion: reduce)'])matchMedia(query).addEventListener('change',media);media();
    ${script}</script></html>`;
}

function validEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const fields = { media: ['kind', 'width', 'height', 'scheme', 'reduced'], drag: ['kind', 'card', 'from', 'to', 'points'], motion: ['kind', 'phases', 'reduced'] }[event.kind];
  if (!fields || Object.keys(event).length !== fields.length || !fields.every(key => Object.hasOwn(event, key))) return false;
  if (event.kind === 'media') return [event.width, event.height].every(n => Number.isInteger(n) && n > 0 && n <= 10000) && ['light', 'dark'].includes(event.scheme) && typeof event.reduced === 'boolean';
  if (event.kind === 'drag') return typeof event.card === 'string' && event.card.length < 100 && event.from === 'Queue' && event.to === 'Review' && Number.isInteger(event.points) && event.points >= 3 && event.points <= 10000;
  return typeof event.reduced === 'boolean' && Array.isArray(event.phases) && event.phases.length <= 3 && event.phases.every(color => ['amber', 'teal', 'violet'].includes(color));
}

export function jobHandler(fixture, origin) {
  const url = new URL(origin);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw Error('local job origin required');
  return async (req, res) => {
    const send = (code, type, body = '') => res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'" }).end(body);
    if (req.headers.host !== url.host) return send(404, 'text/plain');
    if (req.headers.origin && req.headers.origin !== url.origin) return send(403, 'text/plain');
    const prefix = `/${fixture.nonce}/`, route = new URL(req.url, url).pathname;
    if (!route.startsWith(prefix)) return send(404, 'text/plain');
    const tail = route.slice(prefix.length);
    if (req.method === 'GET' && tail === 'api/log') return send(200, 'application/json', JSON.stringify({ kind: fixture.kind, views: fixture.views, events: fixture.events }));
    if (req.method === 'GET' && tail === '') { fixture.views.push(''); return send(200, 'text/html; charset=utf-8', render(fixture)); }
    if (req.method !== 'POST' || tail !== 'event') return send(404, 'text/plain');
    if (req.headers['content-type'] !== 'application/json') return send(400, 'text/plain');
    let text = '', bytes = 0;
    for await (const chunk of req) { bytes += Buffer.byteLength(chunk); if (bytes > 4096) { req.resume?.(); return send(413, 'text/plain'); } text += chunk; }
    let event;
    try { event = JSON.parse(text); } catch { return send(400, 'text/plain'); }
    if (!validEvent(event)) return send(400, 'text/plain');
    if (fixture.events.length >= 1000) return send(429, 'text/plain');
    fixture.events.push(event);
    return send(204, 'text/plain');
  };
}

export function gradeJob({ task, site, answer, expected }) {
  let problem;
  if (!jobKinds.includes(task?.worldFixture) || site?.kind !== task.worldFixture || !expected || !Array.isArray(site?.views) || !Array.isArray(site?.events)) problem = 'JOB_FIXTURE_UNAVAILABLE';
  else if (!site.views.includes('')) problem = 'JOB_PAGE_NOT_READ';
  else {
    const text = String(answer ?? ''), line = text.split('\n').filter(row => /^RESULT:/.test(row)).at(-1);
    let value;
    try { value = JSON.parse(line ? line.slice(7).trim() : text.trim()); } catch { problem = 'JOB_ANSWER_NOT_JSON'; }
    if (!problem && !isDeepStrictEqual(value, expected)) problem = 'JOB_ANSWER_MISMATCH';
    const events = site.events.filter(validEvent);
    if (!problem && task.worldFixture === 'job-kanban' && !events.some(e => e.kind === 'drag' && e.card === expected.card)) problem = 'JOB_DRAG_NOT_PROVED';
    if (!problem && task.worldFixture === 'job-phone' && !events.some(e => e.kind === 'media' && e.width === 390 && e.height === 844)) problem = 'JOB_PHONE_NOT_PROVED';
    if (!problem && task.worldFixture === 'job-dark' && !events.some(e => e.kind === 'media' && e.scheme === 'dark')) problem = 'JOB_DARK_NOT_PROVED';
    if (!problem && ['job-phone', 'job-dark'].includes(task.worldFixture)) {
      const media = events.filter(e => e.kind === 'media');
      if (!isDeepStrictEqual(media[0], media.at(-1))) problem = 'JOB_MEDIA_NOT_RESTORED';
    }
    if (!problem && task.worldFixture === 'job-motion' && !events.some(e => e.kind === 'motion' && e.reduced === false && isDeepStrictEqual(e.phases, expected.phases))) problem = 'JOB_MOTION_NOT_PROVED';
  }
  return { ok: !problem, cell: problem ? `FAIL: ${problem}` : 'ok', problems: problem ? [problem] : [] };
}

// Independent local tasks derived from the BF1 behavior spec, never from a competitor's site.
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { deflateSync } from 'node:zlib';

export const jobKinds = ['job-canvas', 'job-kanban', 'job-phone', 'job-dark', 'job-motion'];
// Fixed motion-answer vocabulary, shared by every arm. Names describe the actual
// sRGB fills: warm yellow-orange, dark blue-green, and violet-purple respectively.
// Only case and surrounding whitespace are normalized; phase order stays exact.
export const jobColors = Object.freeze({
  amber: Object.freeze({ hex: '#ffbf26', names: Object.freeze(['amber', 'yellow', 'gold', 'orange']) }), // RGB 255,191,38
  teal: Object.freeze({ hex: '#138d86', names: Object.freeze(['teal', 'turquoise', 'blue-green']) }), // RGB 19,141,134
  violet: Object.freeze({ hex: '#8753d8', names: Object.freeze(['violet', 'purple']) }), // RGB 135,83,216
});
const palette = Object.fromEntries(Object.entries(jobColors).map(([name, color]) => [name, color.hex]));
function motionColor(value) {
  if (typeof value !== 'string') return value;
  const name = value.trim().toLowerCase();
  return Object.keys(jobColors).find(key => jobColors[key].names.includes(name)) ?? value;
}
const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const instructions = {
  'job-canvas': 'Read the six-digit routing code in the routing slip image. Return JSON with code as a string.',
  'job-kanban': 'Move the card named on the board from Queue into Review by dragging its grip, without opening it. Return JSON with card (the card name) and column (Review).',
  'job-phone': 'Check this page at a phone viewport of 390 by 844 CSS pixels. Without scrolling, is the Reserve button fully visible? Return JSON with width, height and actionVisible (boolean). Restore the original viewport.',
  'job-dark': 'Test this page in dark color scheme. What color is the circular badge: amber, teal or violet? Return JSON with scheme (dark) and badge (the color). Restore the original color scheme.',
  'job-motion': 'Press Play once and inspect the animation as it runs. Report the three colors in order as JSON with phases (an array of color names). The final gray frame is not a phase. Do not enable reduced motion for this test.',
};

export function createJobFixture(kind, { nonce, seed = randomBytes(24).toString('hex') } = {}) {
  if (!jobKinds.includes(kind) || !/^[A-Za-z0-9_-]{1,80}$/.test(nonce ?? '')) throw Error('invalid local job fixture');
  const number = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
  const colors = Object.keys(jobColors);
  const phases = colors.map((_, index) => colors[(index + number % 3) % 3]);
  const phoneSpacer = (number % 2 === 0 ? 240 : 850) + number % 120;
  const expected = {
    'job-canvas': { code: String(100000 + number % 900000) },
    'job-kanban': { card: `Parcel ${100 + number % 900}`, column: 'Review' },
    'job-phone': { width: 390, height: 844, actionVisible: phoneSpacer < 500 },
    'job-dark': { scheme: 'dark', badge: colors[number % colors.length] },
    'job-motion': { phases },
  }[kind];
  return { kind, nonce, expected, phoneSpacer, views: [], events: [] };
}

// A small bitmap font keeps the routing answer exclusively in server-rendered pixels.
const digits = [
  ['01110', '11011', '11011', '11011', '11011', '11011', '01110'],
  ['00110', '01110', '00110', '00110', '00110', '00110', '11111'],
  ['01110', '11011', '00011', '00110', '01100', '11000', '11111'],
  ['11110', '00011', '00011', '01110', '00011', '00011', '11110'],
  ['00011', '00111', '01111', '11011', '11111', '00011', '00011'],
  ['11111', '11000', '11000', '11110', '00011', '00011', '11110'],
  ['01110', '11000', '11000', '11110', '11011', '11011', '01110'],
  ['11111', '00011', '00110', '00110', '01100', '01100', '01100'],
  ['01110', '11011', '11011', '01110', '11011', '11011', '01110'],
  ['01110', '11011', '11011', '01111', '00011', '00011', '01110'],
];
function pngChunk(name, data) {
  const body = Buffer.concat([Buffer.from(name), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(data.length); body.copy(chunk, 4); chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}
function routingPng(code) {
  const width = 480, height = 160, stride = 1 + width * 3, pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const column = Math.floor((x - 90) / 7), row = Math.floor((y - 55) / 7);
    const digit = Math.floor(column / 6), cell = column % 6;
    const ink = digit >= 0 && digit < code.length && row >= 0 && row < 7 && cell >= 0 && cell < 5 && digits[Number(code[digit])][row][cell] === '1';
    const offset = y * stride + 1 + x * 3;
    pixels.set(ink ? [21, 36, 52] : [232, 240, 245], offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
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
    content = `<h1>Routing slip</h1><img id="slip" src="/${nonce}/slip.png" width="480" height="160" alt="Routing code image">`;
  }
  if (kind === 'job-kanban') {
    content = `<h1>Dispatch board</h1><p>Move ${esc(expected.card)} to Review.</p><div class="board"><section id="queue"><h2>Queue</h2><article id="card"><span id="grip" role="button" aria-label="Drag ${esc(expected.card)}" tabindex="0">⠿</span> ${esc(expected.card)}</article></section><section id="review"><h2>Review</h2></section></div><p id="status">Waiting</p>`;
    script = `const grip=document.querySelector('#grip'),card=document.querySelector('#card'),review=document.querySelector('#review'),queue=document.querySelector('#queue');let drag;
      const position=()=>emit({kind:'kanban',card:${JSON.stringify(expected.card)},column:review.contains(card)?'Review':queue.contains(card)?'Queue':'Other'});
      new MutationObserver(position).observe(document.querySelector('.board'),{childList:true,subtree:true});position();
      grip.onpointerdown=e=>{if(!e.isTrusted||e.button!==0||!queue.contains(card))return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,points:0};grip.setPointerCapture(e.pointerId);};
      grip.onpointermove=e=>{if(e.isTrusted&&drag&&e.pointerId===drag.id&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>3)drag.points++;};
      grip.onpointerup=e=>{if(!e.isTrusted||!drag||drag.id!==e.pointerId)return;const r=review.getBoundingClientRect();
        if(drag.points>=3&&e.clientX>r.left&&e.clientX<r.right&&e.clientY>r.top&&e.clientY<r.bottom){review.append(card);document.querySelector('#status').textContent='Moved';emit({kind:'drag',card:${JSON.stringify(expected.card)},from:'Queue',to:'Review',points:drag.points});}drag=null;};
      grip.onpointercancel=e=>{if(e.isTrusted)drag=null;};`;
  }
  if (kind === 'job-phone') content = '<h1>Cabin visit</h1><p>Check the booking action on a phone without scrolling.</p><div class="spacer"></div><button id="reserve" type="button">Reserve</button>';
  if (kind === 'job-dark') {
    content = '<h1>Night palette</h1><p>Read the circular badge color in dark mode.</p><canvas id="badge" width="280" height="180" aria-label="Theme badge image"></canvas>';
    const color = palette[expected.badge];
    script = `const scheme=matchMedia('(prefers-color-scheme: dark)');function paint(){const c=document.querySelector('canvas').getContext('2d');c.clearRect(0,0,280,180);c.fillStyle=scheme.matches?'${color}':'#138d86';c.beginPath();c.arc(140,90,60,0,2*Math.PI);c.fill();}scheme.addEventListener('change',e=>{if(e.isTrusted)paint();});paint();`;
  }
  if (kind === 'job-motion') {
    content = '<h1>Signal preview</h1><button id="play" type="button">Play</button><div id="signal" role="img" aria-label="Animated signal"></div><p id="status">Ready</p>';
    script = `const palette=${JSON.stringify(palette)},signal=document.querySelector('#signal');let played=false;
      document.querySelector('#play').onclick=async e=>{if(!e.isTrusted||played)return;played=true;
        if(matchMedia('(prefers-reduced-motion: reduce)').matches){document.querySelector('#status').textContent='Reduced motion unavailable';return;}
        try{const response=await fetch('/${nonce}/phases',{method:'POST'});if(!response.ok)throw Error('phases unavailable');const phases=await response.json(),seen=[];let index=0;
          function schedule(){let frame,timer,done=false;const step=()=>{if(done)return;done=true;cancelAnimationFrame(frame);clearTimeout(timer);paint();};frame=requestAnimationFrame(step);timer=setTimeout(step,250);}
          function paint(){if(index<phases.length){const color=phases[index];signal.style.background=palette[color];signal.style.transform='translateX('+index*70+'px)';seen.push(color);index++;setTimeout(schedule,180);}
            else{signal.style.background='#777';signal.style.transform='translateX(210px)';document.querySelector('#status').textContent='Finished';emit({kind:'motion',phases:seen,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches});}}
          schedule();
        }catch{document.querySelector('#status').textContent='Unavailable';}};`;
  }
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local ${esc(kind)}</title>
    <style>body{font:18px system-ui;margin:24px;color:#142336;background:#fff}button{padding:12px}.board{display:flex;gap:40px}section{width:280px;height:240px;background:#edf2f8;padding:16px}article{padding:20px;background:white}#grip{display:inline-block;cursor:grab;touch-action:none;padding:12px}#signal{width:80px;height:80px;background:#777;margin:40px}.spacer{height:100px}@media(max-width:500px){.spacer{height:${fixture.phoneSpacer}px}}@media(prefers-color-scheme:dark){body{color:#e4eaf2;background:#142336}}</style>
    ${content}<script>(()=>{
    let pending=Promise.resolve();
    const emit=event=>pending=pending.then(()=>fetch('${eventPath}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(event)})).catch(()=>{});
    const media=e=>{if(e&&!e.isTrusted)return;emit({kind:'media',width:innerWidth,height:innerHeight,scheme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light',reduced:matchMedia('(prefers-reduced-motion: reduce)').matches});};
    addEventListener('resize',media);for(const query of ['(prefers-color-scheme: dark)','(prefers-reduced-motion: reduce)'])matchMedia(query).addEventListener('change',media);media();
    ${script}})();</script></html>`;
}

function validEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const fields = { media: ['kind', 'width', 'height', 'scheme', 'reduced'], drag: ['kind', 'card', 'from', 'to', 'points'], kanban: ['kind', 'card', 'column'], motion: ['kind', 'phases', 'reduced'] }[event.kind];
  if (!fields || Object.keys(event).length !== fields.length || !fields.every(key => Object.hasOwn(event, key))) return false;
  if (event.kind === 'media') return [event.width, event.height].every(n => Number.isInteger(n) && n > 0 && n <= 10000) && ['light', 'dark'].includes(event.scheme) && typeof event.reduced === 'boolean';
  if (event.kind === 'drag') return typeof event.card === 'string' && event.card.length < 100 && event.from === 'Queue' && event.to === 'Review' && Number.isInteger(event.points) && event.points >= 3 && event.points <= 10000;
  if (event.kind === 'kanban') return typeof event.card === 'string' && event.card.length < 100 && ['Queue', 'Review', 'Other'].includes(event.column);
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
    if (req.method === 'GET' && tail === 'api/log') return send(200, 'application/json', JSON.stringify({ kind: fixture.kind, views: fixture.views, events: fixture.events, ...(fixture.kanban ? { kanban: fixture.kanban } : {}) }));
    if (req.method === 'GET' && tail === 'slip.png' && fixture.kind === 'job-canvas') return send(200, 'image/png', routingPng(fixture.expected.code));
    if (req.method === 'POST' && tail === 'phases' && fixture.kind === 'job-motion' && fixture.views.includes('')) return send(200, 'application/json', JSON.stringify(fixture.expected.phases));
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
    if (event.kind === 'kanban' && fixture.kind === 'job-kanban') fixture.kanban = { card: event.card, column: event.column };
    return send(204, 'text/plain');
  };
}

export function gradeJob({ task, site, answer, expected }) {
  let problem;
  if (!jobKinds.includes(task?.worldFixture) || site?.kind !== task.worldFixture || !expected || !Array.isArray(site?.views) || !Array.isArray(site?.events)) problem = 'JOB_FIXTURE_UNAVAILABLE';
  else if (task.worldFixture === 'job-dark' && site.events.filter(validEvent).find(e => e.kind === 'media')?.scheme !== 'light') problem = 'JOB_FIXTURE_UNAVAILABLE';
  else if (!site.views.includes('')) problem = 'JOB_PAGE_NOT_READ';
  else {
    const text = String(answer ?? ''), line = text.split('\n').filter(row => /^RESULT:/.test(row)).at(-1);
    let value;
    try { value = JSON.parse(line ? line.slice(7).trim() : text.trim()); } catch { problem = 'JOB_ANSWER_NOT_JSON'; }
    if (task.worldFixture === 'job-motion' && Array.isArray(value?.phases)) value = { ...value, phases: value.phases.map(motionColor) };
    if (!problem && !isDeepStrictEqual(value, expected)) problem = 'JOB_ANSWER_MISMATCH';
    const events = site.events.filter(validEvent);
    if (!problem && task.worldFixture === 'job-kanban' && (!events.some(e => e.kind === 'drag' && e.card === expected.card) || !isDeepStrictEqual(site.kanban, expected))) problem = 'JOB_DRAG_NOT_PROVED';
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

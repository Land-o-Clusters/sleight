import { createHash } from 'node:crypto';

const json = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** The same pure timeline reducer runs in Node tests and in the exported page. No capture, network or voice synthesis. */
export function replayFrame(records, index) {
  const end = Math.min(records.length - 1, Math.max(0, index));
  let shot, event, narration = '', status = '', sequence = 0, gaps = 0;
  for (let i = 0; i <= end; i++) {
    const row = records[i];
    if (row.v === 'sleight.run/1' && row.type === 'screenshot') shot = row;
    if (row.v === 'sleight.cursor/1') {
      if (sequence && row.seq > sequence + 1) gaps += row.seq - sequence - 1;
      sequence = row.seq;
      if (row.type === 'status') status = row.state;
      if (row.type === 'action') event = row;
      if (typeof row.say === 'string') narration = row.say;
    }
  }
  const point = event?.point, bounds = shot?.window?.rect ?? event?.window?.rect;
  const mapped = Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) &&
    Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite) && bounds[2] > 0 && bounds[3] > 0 &&
    event.window?.id === shot?.window?.id && shot?.window?.id > 0 && ['aim', 'act', 'done'].includes(event.phase) &&
    shot.image?.width > 0 && shot.image?.height > 0 && Math.abs((shot.image.width / shot.image.height) / (bounds[2] / bounds[3]) - 1) <= 0.03;
  const xy = mapped ? [(point[0] - bounds[0]) / bounds[2] * 100, (point[1] - bounds[1]) / bounds[3] * 100] : undefined;
  return { shot, event, narration, status, gaps, point: xy?.every(n => n >= 0 && n <= 100) ? xy : undefined };
}

// The page uses DOM text nodes for every recorded string. Only the checked JPEG data becomes a resource URL.
function player() {
  const records = JSON.parse(document.getElementById('run-data').textContent);
  const slider = document.getElementById('timeline'), image = document.getElementById('screenshot'), ring = document.getElementById('ring');
  const text = (id, value) => { document.getElementById(id).textContent = value; };
  slider.max = Math.max(0, records.length - 1);
  slider.disabled = !records.length;
  function draw() {
    const at = Number(slider.value), frame = replayFrame(records, at), row = records[at];
    text('position', records.length ? `${at + 1} / ${records.length} records, +${((row.ts - records[0].ts) / 1000).toFixed(2)} s` : 'No records');
    const shot = frame.shot?.image;
    const valid = shot?.mimeType === 'image/jpeg' && typeof shot.data === 'string' && shot.data.length <= 262144 && /^[A-Za-z0-9+/]+={0,2}$/.test(shot.data);
    image.hidden = !valid;
    if (valid) image.src = 'data:image/jpeg;base64,' + shot.data; else image.removeAttribute('src');
    ring.hidden = !valid || !frame.point;
    if (frame.point) { ring.style.left = frame.point[0] + '%'; ring.style.top = frame.point[1] + '%'; }
    ring.dataset.phase = frame.event?.phase ?? '';
    const event = frame.event;
    text('event', event ? [event.phase, event.kind, event.label, event.timing].filter(Boolean).join(' · ') : frame.status || 'No actions yet');
    text('narration', frame.narration);
    text('notice', !valid ? 'No screenshot recorded at this point.' : !frame.point ? 'No matching screen geometry. Cursor point is unavailable.' :
      'Cursor points use the recorded window geometry. Scheduled points are predictions.');
    text('gaps', frame.gaps ? `${frame.gaps} cursor events missing before this point.` : '');
    text('shot-time', frame.shot ? `Screenshot +${((frame.shot.ts - records[0].ts) / 1000).toFixed(2)} s. Images are snapshots between actions.` : '');
  }
  slider.addEventListener('input', draw);
  document.getElementById('previous').addEventListener('click', () => { slider.value = Math.max(0, Number(slider.value) - 1); draw(); });
  document.getElementById('next').addEventListener('click', () => { slider.value = Math.min(Number(slider.max), Number(slider.value) + 1); draw(); });
  draw();
}

function documentHTML(data, script, body) {
  const hash = createHash('sha256').update(script).digest('base64');
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>sleight run replay</title>
<style>
body{color:#ede9df;background:#131a26;font:16px system-ui;margin:2rem auto;padding:0 1rem;max-width:1100px}
button,input{font:inherit}button{margin:.5rem;padding:.35rem .8rem}input{width:100%}
#stage{position:relative;display:inline-block;max-width:100%;line-height:0}#screenshot{max-width:100%;height:auto}
#ring{position:absolute;width:28px;height:28px;transform:translate(-50%,-50%);border:3px solid #ff7a3d;border-left-color:#5b8dff;border-bottom-color:#5b8dff;border-radius:50%;box-shadow:0 0 0 2px #131a26;box-sizing:border-box}
#ring:after{content:'';position:absolute;width:4px;height:4px;background:#fff;left:9px;top:9px;border-radius:50%}
#ring[data-phase=aim]{border-style:dashed}#ring[data-phase=act]{width:22px;height:22px}#ring[data-phase=act]:after{left:6px;top:6px}
#ring[data-phase=done]{opacity:.7}p{line-height:1.5}#narration{white-space:pre-wrap}small{color:#c2c6cf}li{margin:1rem 0;overflow-wrap:anywhere}
[hidden]{display:none!important}
</style>
<h1>sleight runs</h1><p>Local replay. Screenshots can contain private content. This file includes the recorded data.</p>
${body}
<script id="run-data" type="application/json">${json(data)}</script><script>${script}</script></html>`;
}

export function buildRunHTML(records) {
  // Only the selected JSONL's records are embedded. No disk paths, app queries or screenshot sidecars are read.
  const data = records.filter(r => r && Number.isFinite(r.ts) && ['sleight.cursor/1', 'sleight.run/1'].includes(r.v));
  const script = replayFrame.toString() + '\n(' + player.toString() + ')();';
  return documentHTML(data, script, `<label for="timeline">Timeline</label><input id="timeline" type="range" min="0" step="1" value="0">
<button id="previous" type="button">Previous</button><button id="next" type="button">Next</button>
<output id="position"></output><p id="event"></p><p id="narration" aria-live="polite"></p>
<div id="stage"><img id="screenshot" alt="Recorded app screenshot" hidden><span id="ring" aria-hidden="true" hidden></span></div>
<p id="notice"></p><p><small id="shot-time"></small></p><p id="gaps"></p>
<p><small>Orange #ff7a3d and blue #5b8dff are Split Seam+ colors. Dashed: aim. Tight: act. Faded: done.</small></p>`);
}

export function buildRunsHTML(rows) {
  function listing() {
    const rows = JSON.parse(document.getElementById('run-data').textContent), list = document.getElementById('runs');
    for (const row of rows) { const li = document.createElement('li'); li.textContent = `${row.id} (${row.bytes} bytes). Open: sleight-mcp runs open ${row.id}`; list.append(li); }
    if (!rows.length) list.textContent = 'No recordings. Recording is off by default.';
  }
  return documentHTML(rows, '(' + listing.toString() + ')();', '<p>Run the open command for a recording to build its replay.</p><ul id="runs"></ul>');
}

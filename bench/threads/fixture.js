// Local deterministic data only. Virtual rows deliberately reuse the same nodes.
const thread = document.querySelector('#thread'), rows = document.querySelector('#rows');
const start = document.querySelector('#start'), end = document.querySelector('#end');
const kind = thread.dataset.kind, total = kind === 'virtual' ? 1000 : 100;
let lo = kind === 'chat' ? 81 : 1, hi = kind === 'feed' ? 20 : total, loading = false;
window.fixtureStats = { loads: 0, renders: 0 };
function row(node, n) {
  node.dataset.messageId = String(n);
  node.setAttribute('role', 'listitem');
  node.setAttribute('aria-posinset', String(n));
  node.textContent = `row-${String(n).padStart(4, '0')} ${kind} content`;
  return node;
}
const pool = kind === 'virtual' ? Array.from({ length: 32 }, () => rows.appendChild(document.createElement('article'))) : [];
function render() {
  fixtureStats.renders++;
  start.textContent = lo === 1 ? 'Beginning of thread' : '';
  end.textContent = hi === total ? 'End of thread' : '';
  if (kind === 'virtual') {
    rows.style.height = `${total * 24}px`;
    const first = Math.min(total - pool.length + 1, Math.max(1, Math.floor((thread.scrollTop - 24) / 24) - 3));
    pool.forEach((node, i) => {
      row(node, first + i);
      node.style.cssText = `position:absolute;left:0;right:0;top:${(first + i - 1) * 24}px`;
    });
  } else {
    rows.replaceChildren(...Array.from({ length: hi - lo + 1 }, (_, i) => row(document.createElement('article'), lo + i)));
  }
}
async function onScroll() {
  if (kind === 'virtual') { render(); return; }
  if (loading || (kind === 'chat' ? thread.scrollTop > 1 || lo === 1 : thread.scrollTop + thread.clientHeight < thread.scrollHeight - 1 || hi === total)) return;
  loading = true;
  thread.setAttribute('aria-busy', 'true');
  const height = thread.scrollHeight, top = thread.scrollTop;
  await new Promise(resolve => setTimeout(resolve, 120));
  fixtureStats.loads++;
  if (kind === 'chat') lo = Math.max(1, lo - 20);
  else hi = Math.min(total, hi + 20);
  render();
  if (kind === 'chat') thread.scrollTop = top + thread.scrollHeight - height;
  thread.setAttribute('aria-busy', 'false');
  loading = false;
}
render();
if (kind === 'chat') thread.scrollTop = thread.scrollHeight;
thread.addEventListener('scroll', onScroll, { passive: true });
// An upward wheel must load history even if the initial 20 rows fit the viewport.
thread.addEventListener('wheel', event => {
  if (kind === 'chat' && event.deltaY < 0 || kind === 'feed' && event.deltaY > 0) onScroll();
}, { passive: true });

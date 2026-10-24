import { trustedRead } from './trusted-dom.mjs';
import { recipeControl, recipeOrigin, RECIPE_NAMES } from '../site-memory.mjs';

// Observation is optional. A stalled renderer must not hold an otherwise finished action for a recipe.
async function within(task, deadline) {
  let timer;
  try {
    return await Promise.race([task, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(Error('CONTROL_OBSERVATION_UNAVAILABLE'), { code: 'CONTROL_OBSERVATION_TIMEOUT' })), Math.max(0, deadline - performance.now()));
    })]);
  } finally { clearTimeout(timer); }
}
const readControl = (handle, path, deadline = performance.now() + 200) => within(trustedRead(handle, controlState, { names: RECIPE_NAMES, path }), deadline);

// Runs only in the utility world against the retained clicked node. Values and document text are never returned.
function controlState(el, { names, path }, read) {
  const doc = read(el, 'ownerDocument');
  if (read(el, 'isConnected') !== true && path) {
    // Re-rendering alone is not a change. Inspect only the replacement in the same structural slot of this document.
    let replacement = doc;
    for (const index of path) replacement = read(replacement, 'children')?.[index];
    if (!replacement || read(replacement, 'isConnected') !== true) return null;
    el = replacement;
  }
  const get = key => read(el, 'getAttribute')(key), tag = read(el, 'localName');
  const role = get('role') || (tag === 'button' ? 'button' : '');
  if (!['button', 'menuitem', 'tab'].includes(role) || ['input', 'textarea', 'select'].includes(tag) ||
      read(el, 'isContentEditable') === true || get('aria-labelledby') || read(el, 'closest')('form')) return null;
  const raw = get('aria-label') || read(el, 'textContent') || '';
  if (raw.length > 24) return null;
  const name = names.find(name => name.toLowerCase() === raw.toLowerCase().replace(/(?:…|\.\.\.)$/, '').trim());
  if (!name) return null;
  if (!path && read(el, 'isConnected') === true) {
    const indices = [];
    for (let at = el; at && at !== doc && indices.length < 32;) {
      const parent = read(at, 'parentNode'), children = read(parent, 'children');
      if (!parent || !children || children.length > 4096) break;
      indices.unshift(Array.prototype.indexOf.call(children, at)); at = parent;
      if (at === doc) path = indices;
    }
  }
  let origin;
  try { origin = new URL(read(doc, 'URL')).origin; } catch { return null; }
  return { target: { role, name }, origin, connected: read(el, 'isConnected') === true,
    hidden: !!read(el, 'closest')('[hidden],[aria-hidden="true"]'),
    expanded: get('aria-expanded'), pressed: get('aria-pressed'), selected: get('aria-selected'), checked: get('aria-checked'), path };
}

export async function prepareControlRecipe(locator, url, observation = {}) {
  if (observation.stalled) return null;
  let handle, abandoned = false;
  const deadline = performance.now() + 250;
  const owned = typeof locator?.elementHandle === 'function';
  // Disposal can itself wait for an unresponsive renderer, so it never extends the optional observation deadline.
  const dispose = () => { if (owned && handle) { const closing = handle; handle = undefined; Promise.resolve(closing.dispose()).catch(() => {}); } };
  try {
    handle = owned ? await within(Promise.resolve(locator.elementHandle({ timeout: 250 })).then(value => {
      if (abandoned) { Promise.resolve(value?.dispose()).catch(() => {}); return; }
      return value;
    }), deadline) : locator;
    // The same closed vocabulary is used by persistence. Only control words enter the reader's response.
    const before = await readControl(handle, undefined, deadline);
    if (!before?.connected || before.hidden || !recipeControl(before.target) || !recipeOrigin(before.origin) || new URL(url).origin !== before.origin) {
      await dispose(); return null;
    }
    return {
      async finish() {
        const after = await readControl(handle, before.path);
        if (!after?.connected || JSON.stringify(after.target) !== JSON.stringify(before.target) || after.origin !== before.origin) return;
        if (['hidden', 'expanded', 'pressed', 'selected', 'checked'].every(key => after[key] === before[key])) return;
        return { origin: before.origin, target: before.target, outcome: 'control changed', expanded: after.expanded === 'true' };
      },
      dispose,
    };
  } catch (error) {
    if (error?.code === 'CONTROL_OBSERVATION_TIMEOUT' || error?.name === 'TimeoutError') observation.stalled = true;
    abandoned = true; try { dispose(); } catch {} return null;
  }
}

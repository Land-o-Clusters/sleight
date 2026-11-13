import { MAC_DRIVER_ROLES } from './roles.mjs';

// DriverTree delimits a label that could extend a role with an empty state
// group. Match the closed vocabulary longest first, never words from a label.
const surfaceRoles = new Set(['menu', 'sheet', 'dialog', 'alert', 'popover', 'floating window']);
const itemRoles = new Set(['menu item', 'menu bar item']);
const rowRole = body => MAC_DRIVER_ROLES.find(role => body === role || body.startsWith(role + ' ') || body.startsWith(role + ','));

function snapshot(text) {
  const surfaces = [], items = [];
  for (const line of text.split('\n')) {
    const row = /^(\t*)\d+ (.*)$/.exec(line);
    if (!row) continue;
    const body = row[2], role = rowRole(body);
    if (!surfaceRoles.has(role) && !itemRoles.has(role)) continue;
    const state = /^ \(([^)]*)\)(?= |$)/.exec(body.slice(role.length));
    const states = state && state[1] ? state[1].split(', ') : [];
    if (itemRoles.has(role)) {
      // Labels, enabled state and disabled are not input-surface changes.
      // Keep selection gains on an existing item. DriverTree emits selected.
      items.push({ role, depth: row[1], selected: states.includes('selected') });
      continue;
    }
    const tail = body.slice(role.length + (state?.[0].length ?? 0));
    const normalized = role === 'menu' && states.includes('collapsed') && !states.includes('expanded')
      ? states.filter(state => state !== 'disabled') : states;
    surfaces.push(JSON.stringify([row[1], role, normalized, tail]));
  }
  // Preserve multiplicity and detect removals as well as additions.
  return { surfaces: surfaces.sort(), items };
}

export function macInputSurfaceChanged(before, after) {
  const prior = snapshot(before), current = snapshot(after);
  if (JSON.stringify(prior.surfaces) !== JSON.stringify(current.surfaces)) return true;
  return current.items.some((item, i) =>
    item.selected && (item.role !== prior.items[i]?.role || item.depth !== prior.items[i]?.depth || !prior.items[i]?.selected));
}

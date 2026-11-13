import { compoundDomain } from './observation.mjs';
import { requireCompound } from './intent.mjs';

// The proved menu bar is the only root. Follow each literal child relation,
// including dormant children, never a global descendant or enabled-only search.
// null means the requested leaf is absent, and permits the old lazy-menu path.
// Ambiguity, unreadable structure and ineligible nodes never permit fallback.
export function resolveUnopenedMenu(snapshot, selectors) {
  const domain = compoundDomain(snapshot, 'menu', snapshot.binding.root);
  const bar = snapshot.nodes.find(n => n.token === domain.container);
  requireCompound(bar?.role === 'AXMenuBar' && bar.active && !bar.expanded, 'UNSUPPORTED_TRANSITION');
  requireCompound(!snapshot.nodes.some(n => ['AXMenu', 'AXMenuItem', 'AXMenuBarItem'].includes(n.role) &&
    (n.expanded || n.role === 'AXMenu' && n.active)), 'UNEXPECTED_TRANSITION');
  let container = bar.token;
  const path = [];
  for (const [index, selector] of selectors.entries()) {
    const children = snapshot.nodes.filter(n => n.parent === container);
    const matches = children.filter(n => n.role === selector.role && n[selector.source] === selector.label);
    requireCompound(matches.length < 2, 'AMBIGUOUS_STEP');
    if (!matches.length) {
      requireCompound(!children.some(n => n[selector.source] === selector.label), 'STEP_NOT_FOUND');
      return null;
    }
    const node = matches[0];
    requireCompound(!node.secure, 'SECURE_FIELD');
    path.push(node);
    const submenus = snapshot.nodes.filter(n => n.parent === node.token);
    if (index === selectors.length - 1) {
      requireCompound(node.role === 'AXMenuItem' && submenus.length === 0, 'UNSUPPORTED_TRANSITION');
      // AppKit may validate enabled only on open. Try this leaf once under a
      // reviewed contract; a no-effect press must return the following read.
      return { node, path };
    }
    requireCompound(node.enabled, 'STEP_DISABLED');
    requireCompound(submenus.length < 2, 'AMBIGUOUS_STEP');
    if (!submenus.length) return null;
    requireCompound(submenus[0].role === 'AXMenu' && !submenus[0].secure, 'UNSUPPORTED_TRANSITION');
    container = submenus[0].token;
  }
  return null;
}

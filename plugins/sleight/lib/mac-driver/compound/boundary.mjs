// Restricted lexical boundary check. A clear result supplies no mechanism
// authority. The registry must separately prove the transition's local effect.
import { classifyConsequentialLabel, normalizeActionLabel } from '../diff.mjs';
import { isPaymentTarget } from '../../document-scope.mjs';
import { sessionMenuRequestAllowed } from '../../session-menu.mjs';

export const normalizeCompoundLabel = normalizeActionLabel;
const extraBoundary = /(?<![\p{L}\p{N}])(?:sign ?in|sign ?up|log ?in|create account|security|privacy|consent|allow|password|two factor|recovery|connected apps|overwrite|keep both|replace all)(?![\p{L}\p{N}])/u;
export function compoundLabelBoundary(raw) {
  const label = normalizeCompoundLabel(raw);
  if (!label) return 'unknown';
  return classifyConsequentialLabel(raw) === 'boundary' || extraBoundary.test(label) || isPaymentTarget('button ' + label) ? 'boundary' : 'clear';
}
export function classifyCompoundTarget({ transition, snapshot, application, menuRequests = [] }) {
  const node = transition?.node;
  if (!node || node.secure || !['AXMenuBarItem', 'AXMenuItem', 'AXPopUpButton', 'AXTextField'].includes(node.role)) return 'unknown';
  if (!['title', 'description', 'help'].every(k => node[k] === null || typeof node[k] === 'string' && node[k].isWellFormed())) return 'unknown';
  const labels = [node.title, node.description, node.help].filter(v => v !== null && v !== '');
  if (!labels.length) return 'unknown';
  const menu = ['AXMenuItem', 'AXMenuBarItem'].includes(node.role);
  let apple = false, parent = node.parent;
  const seen = new Set([node.token]);
  while (menu && parent && !seen.has(parent)) {
    seen.add(parent);
    const ancestor = snapshot?.nodes.find(n => n.token === parent);
    if (!ancestor) break;
    if (ancestor.role === 'AXMenuBarItem' && [ancestor.title, ancestor.description].some(label => /^(?:Apple|)(?: menu)?$/i.test(label ?? ''))) apple = true;
    parent = ancestor.parent;
  }
  for (const label of labels) {
    if (menu && !sessionMenuRequestAllowed(label, { app: application, apple }, menuRequests)) return 'boundary';
    // Save As is the panel opener or the basename field, never a commit button.
    // Its registry contract still has to prove non-submitting behavior.
    if (['save.open', 'save.basename'].includes(transition.kind) &&
        /^save as(?:\.{3}|…)?$/.test(normalizeCompoundLabel(label) ?? '')) continue;
    if (compoundLabelBoundary(label) !== 'clear') return 'boundary';
  }
  // The popup's selected value is also part of its target, but typed filenames
  // and directory values are data, never command labels.
  if (node.role !== 'AXTextField' && node.value !== null && compoundLabelBoundary(node.value) !== 'clear') return 'boundary';
  if (menu && node.value && !sessionMenuRequestAllowed(node.value, { app: application, apple }, menuRequests)) return 'boundary';
  return 'local';
}

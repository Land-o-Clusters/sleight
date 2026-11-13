// Data adapter for recorded relay reads, not a second tree parser in production.
// Numbered rows and field/flag tokens come from the existing relay fixtures.
import { readFileSync } from 'node:fs';
import { windowFromText } from '../../plugins/sleight/lib/document-scope.mjs';

export const ROLE_CASES = [
  ['AXWindow', 'standard window'], ['AXButton', 'button'], ['AXStaticText', 'text'],
  ['AXTextField', 'text field'], ['AXSecureTextField', 'secure text field'], ['AXTextArea', 'text entry area'],
  ['AXComboBox', 'combo box'], ['AXCheckBox', 'checkbox'], ['AXRadioButton', 'radio button'],
  ['AXGroup', 'container'], ['AXScrollArea', 'scroll area'], ['AXMenu', 'menu'], ['AXMenuBar', 'menu bar'],
  ['AXMenuBarItem', 'menu bar item'], ['AXMenuItem', 'menu item'], ['AXSheet', 'sheet'], ['AXDialog', 'dialog'],
  ['AXPopover', 'popover'], ['AXAlert', 'alert'], ['AXSplitGroup', 'split group'], ['AXToolbar', 'toolbar'],
  ['AXTabGroup', 'tab group'], ['AXTable', 'table'], ['AXRow', 'row'], ['AXColumn', 'column'], ['AXCell', 'cell'],
  ['AXOutline', 'outline'], ['AXImage', 'image'], ['AXLink', 'link'], ['AXWebArea', 'web area'], ['AXSlider', 'slider'],
  ['AXList', 'list'], ['AXLayoutArea', 'layout area'], ['AXLayoutItem', 'layout item'], ['AXHeading', 'heading'],
  ['AXPopUpButton', 'pop up button'], ['AXDisclosureTriangle', 'disclosure triangle'], ['AXValueIndicator', 'value indicator'],
  ['AXMenuButton', 'menu button'], ['AXTab', 'tab'], ['AXProgressIndicator', 'progress indicator'], ['AXSwitch', 'switch'],
  ['AXStepper', 'stepper'], ['AXSearchField', 'search field'], ['AXSplitter', 'splitter'], ['AXScrollBar', 'scroll bar'],
  ['AXHTMLContent', 'HTML content'], ['AXToggleButton', 'toggle button'], ['AXBrowser', 'browser'], ['AXRuler', 'ruler'],
  ['AXRulerMarker', 'ruler marker'], ['AXColorWell', 'color well'], ['AXHandle', 'handle'], ['AXGrid', 'grid'],
  ['AXSeparator', 'separator'], ['AXIncrementArrow', 'increment arrow button'], ['AXDecrementArrow', 'decrement arrow button'],
  ['AXIncrementPage', 'increment page button'], ['AXDecrementPage', 'decrement page button'],
];
export const SUBROLE_CASES = [
  ['AXCloseButton', 'close button'], ['AXZoomButton', 'zoom button'], ['AXMinimizeButton', 'minimize button'],
  ['AXFullScreenButton', 'full screen button'], ['AXSearchField', 'search field'], ['AXSecureTextField', 'secure text field'],
  ['AXToggleButton', 'toggle button'], ['AXSwitch', 'switch'], ['AXTabButton', 'tab'], ['AXDialog', 'dialog'],
  ['AXSystemDialog', 'dialog'], ['AXFloatingWindow', 'floating window'], ['AXSystemFloatingWindow', 'floating window'],
];
export const excelTree = JSON.parse(readFileSync(new URL('./excel-reacquire.json', import.meta.url), 'utf8')).inventory;
export const calculatorTree = readFileSync(new URL('./calculator-tree.txt', import.meta.url), 'utf8');
export const frame = { x: 0, y: 0, width: 100, height: 100 };

export function recordedFixture(text) {
  const window = windowFromText(text), roots = [], stack = [];
  const roles = [...ROLE_CASES, ...SUBROLE_CASES.map(([subrole, role]) => ['AXButton', role, subrole])]
    .sort((a, b) => b[1].length - a[1].length);
  const focus = /^The focused UI element is (\d+) /m.exec(text)?.[1];
  const rows = [...text.matchAll(/^(\t*)(\d+) (.*)$/gm)];
  for (const [, tabs, number, body] of rows) {
    const mapping = roles.find(([, label]) => body === label || body.startsWith(label + ' ') || body.startsWith(label + ','));
    // Engine menu-bar items can be bare titles, without a role token.
    const [ax, role, subrole] = mapping ?? ['AXMenuBarItem', '', undefined];
    let rest = body.slice(role.length).trimStart(), flags = [];
    if (rest.startsWith('(')) { const at = rest.indexOf(')'); flags = rest.slice(1, at).split(', '); rest = rest.slice(at + 1).trimStart(); }
    const node = { AXRole: ax, frame, pid: 42, children: [], actions: [] };
    if (subrole) node.AXSubrole = subrole;
    if (flags.includes('disabled')) node.AXEnabled = false;
    if (flags.includes('focused') || number === focus) node.AXFocused = true;
    if (flags.includes('selectable') || flags.includes('selected')) { node.AXSelected = flags.includes('selected'); node.selectable = true; }
    if (flags.includes('settable')) node.settable = true;
    if (flags.includes('expanded') || flags.includes('collapsed')) node.AXExpanded = flags.includes('expanded');
    const fields = [...rest.matchAll(/(?:^|, )(Description|Value|ID|Help|URL|Details|Placeholder|Selected text|Secondary Actions): /g)];
    const title = fields.length ? rest.slice(0, fields[0].index).replace(/, ?$/, '') : rest;
    if (title) node.AXTitle = title;
    for (let i = 0; i < fields.length; i++) {
      const value = rest.slice(fields[i].index + fields[i][0].length, fields[i + 1]?.index ?? rest.length);
      const name = fields[i][1];
      if (name === 'Secondary Actions') {
        for (const [j, label] of value.split(', ').entries()) { const action = 'AXRecorded' + j; node.actions.push(action); (node.actionDescriptions ??= {})[action] = label; }
      } else {
        const attr = { Description: 'AXDescription', Value: 'AXValue', ID: 'AXIdentifier', Help: 'AXHelp', URL: 'AXURL',
          Details: 'AXDetails', Placeholder: 'AXPlaceholderValue', 'Selected text': 'AXSelectedText' }[name];
        node[attr] = name === 'Value' && flags.includes('float') ? Number(value) : value;
      }
    }
    if (flags.includes('float') && node.AXValue === undefined && /^\d/.test(title)) node.AXValue = Number(title);
    if (flags.includes('checked')) node.AXValue = true;
    while (stack.length && stack.at(-1).depth >= tabs.length) stack.pop();
    if (stack.length) stack.at(-1).node.children.push(node); else roots.push(node);
    stack.push({ depth: tabs.length, node });
  }
  const root = roots[0];
  root.AXMinimized = false; root.AXFullScreen = false;
  return { apps: [{ id: 'test.recorded', name: window.app, pid: 42, processStart: '1.2', useCount: 0 }],
    windows: [{ windowId: '7', pid: 42, processStart: '1.2', app: window.app, title: '', bounds: frame,
      onScreen: true, layer: 0, hidden: false }],
    trees: { '7': root }, menu: roots.find(node => node.AXRole === 'AXMenuBar') };
}

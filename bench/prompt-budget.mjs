// Offline inventory of sleight's prompt sources. No engine or host helper is started.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import ts from 'typescript';
import { skillRules, localToolDefinitions } from '../plugins/sleight/lib/launch.mjs';
import { batchingDescription, createRelay, promptNotice } from '../plugins/sleight/lib/relay.mjs';
import { FLOW_TOOL } from '../plugins/sleight/lib/flow-rules.mjs';

const firstRule = 'execute exactly one of the API calls shown below, optionally assigning its result to a variable. Do not add other API calls, waits, or snapshots to that invocation.';
const skillPath = fileURLToPath(new URL('../plugins/sleight/skills/drive-mac-apps/SKILL.md', import.meta.url));
const size = text => ({ characters: [...text].length, lines: text ? text.split('\n').length : 0 });

function tools(prompt) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  let result;
  clientOut.on('data', bytes => { result = JSON.parse(bytes.toString()); });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, prompt,
    approvalScope: 'document', changeReview: true, localTools: { tools: localToolDefinitions({ SLEIGHT_PROMPT: prompt }) } });
  try {
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'turn_ended' }] } }) + '\n');
    // Document mode hides some local tools, so inventory both surfaces once.
    return [...localToolDefinitions({ SLEIGHT_PROMPT: prompt }), ...result.result.tools.filter(t => !['select_window'].includes(t.name)), FLOW_TOOL];
  } finally {
    relay.dispose();
    for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy();
  }
}

function descriptions(value, path = '') {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => key === 'description' ? [{ path, text: item }] : descriptions(item, `${path}.${key}`));
}

// Each authored result template is counted once, including inactive safety paths.
// Interpolated UI data is represented by <value>. Engine docs, screenshots and UI trees vary by run.
export function noticeInventory(prompt, source = readFileSync(new URL('../plugins/sleight/lib/relay.mjs', import.meta.url), 'utf8')) {
  const ast = ts.createSourceFile('relay.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const entries = [];
  function render(node) {
    if (ts.isIdentifier(node) && node.text === 'undefined') return '';
    if (ts.isParenthesizedExpression(node)) return render(node.expression);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => render(span.expression) + span.literal.text).join('');
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return render(node.left) + render(node.right);
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) return [render(node.left), render(node.right)].filter(Boolean).join('\n');
    if (ts.isConditionalExpression(node)) return [render(node.whenTrue), render(node.whenFalse)].filter(Boolean).join('\n');
    if (ts.isArrowFunction(node)) return render(node.body);
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'promptNotice') return promptNotice(render(node.arguments[0]), prompt);
    return '<value>';
  }
  function add(node, label) {
    const text = render(node);
    if (text.replaceAll('<value>', '').trim()) entries.push({ path: `${label}:${ast.getLineAndCharacterOfPosition(node.getStart()).line + 1}`, text });
  }
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'text' && ts.isObjectLiteralExpression(node.parent) &&
        node.parent.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'type' && p.initializer.text === 'text')) add(node.initializer, 'result');
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText(ast) === 'windowNote') add(node.right, 'window notice');
    if (ts.isVariableDeclaration(node) && ['advice', 'diagnosisAdvice'].includes(node.name.getText(ast))) add(node.initializer, node.name.getText(ast));
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(ast);
      if (['leaseStop', 'documentStop', 'flowStop', 'changeStop', 'remapNotes.set', 'promptFailures.set'].includes(name) && node.arguments[1]) add(node.arguments[1], name);
    }
    if (ts.isFunctionDeclaration(node) && ['openMenuNote', 'selectionRecovery', 'confirmRecovery', 'reportPreapprovals'].includes(node.name?.text)) {
      function returns(child) {
        if (ts.isReturnStatement(child) && child.expression) add(child.expression, node.name.text);
        if (ts.isVariableDeclaration(child) && child.name.getText(ast) === 'text') {
          // Preapproval data is variable; count its one authored sentence template.
          function templates(part) { if (ts.isTemplateExpression(part)) add(part, 'preapproval'); else ts.forEachChild(part, templates); }
          templates(child.initializer);
        }
        ts.forEachChild(child, returns);
      }
      returns(node.body);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return entries;
}

export function sharedNoticeInventory(prompt) {
  const functions = {
    'read-failure.mjs': ['savePanelNote', 'offSpaceNote', 'readFailureAdvice'],
    'simulator-focus.mjs': ['simulatorScreenshotNote'],
    'blocked-apps.mjs': ['forbiddenTargetWarning'],
    'checked-stop.mjs': ['stopText'],
    'compact-reads.mjs': ['saveFinishLine'],
  };
  const entries = [];
  function render(node) {
    if (ts.isIdentifier(node) && node.text === 'undefined') return '';
    if (ts.isParenthesizedExpression(node)) return render(node.expression);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => render(span.expression) + span.literal.text).join('');
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return render(node.left) + render(node.right);
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) return [render(node.left), render(node.right)].filter(Boolean).join('\n');
    if (ts.isConditionalExpression(node)) return [render(node.whenTrue), render(node.whenFalse)].filter(Boolean).join('\n');
    return '<value>';
  }
  for (const file of [...Object.keys(functions), 'clipboard.mjs']) {
    const ast = ts.createSourceFile(file, readFileSync(new URL(`../plugins/sleight/lib/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const add = node => {
      const raw = render(node);
      const text = ['read-failure.mjs', 'simulator-focus.mjs'].includes(file) ? promptNotice(raw, prompt) : raw;
      if (text.replaceAll('<value>', '').trim()) entries.push({ path: `${file}:${ast.getLineAndCharacterOfPosition(node.getStart()).line + 1}`, text });
    };
    function visit(node, selected = false) {
      if (ts.isFunctionDeclaration(node)) selected = functions[file]?.includes(node.name?.text);
      if (selected && ts.isReturnStatement(node) && node.expression) add(node.expression);
      if (ts.isVariableDeclaration(node) && node.initializer &&
          ((selected && ['recovery', 'reason'].includes(node.name.getText(ast))) ||
           (file === 'compact-reads.mjs' && ['body', 'note', 'degradedNote'].includes(node.name.getText(ast))))) add(node.initializer);
      if (file === 'clipboard.mjs' && ts.isCallExpression(node) && node.expression.getText(ast) === 'notice') add(node.arguments[0]);
      ts.forEachChild(node, child => visit(child, selected));
    }
    visit(ast);
  }
  return entries;
}

export function budget() {
  const variants = ['default', 'lean'];
  const rows = ['skill', 'tool descriptions', 'js rewrite', 'relay notices', 'shared notices'].map(source => ({ source }));
  const details = {};
  for (const variant of variants) {
    const prompt = variant === 'lean' ? 'lean' : undefined;
    const toolEntries = tools(prompt).flatMap(tool => descriptions(tool, tool.name));
    const notices = noticeInventory(prompt), shared = sharedNoticeInventory(prompt);
    const metadata = readFileSync(skillPath, 'utf8').match(/^---\n[\s\S]*?\n---\n+/)[0];
    const texts = [metadata + skillRules(skillPath, { SLEIGHT_PROMPT: prompt }), toolEntries.map(e => e.text).join('\n'),
      batchingDescription(firstRule, true, prompt), notices.map(e => e.text).join('\n'), shared.map(e => e.text).join('\n')];
    rows.forEach((row, i) => { row[variant] = size(texts[i]); });
    details[variant] = { tools: toolEntries.map(e => ({ source: e.path, ...size(e.text) })), notices: notices.map(e => ({ source: e.path, ...size(e.text) })), shared: shared.map(e => ({ source: e.path, ...size(e.text) })) };
  }
  const total = Object.fromEntries(variants.map(variant => [variant, { characters: rows.reduce((sum, row) => sum + row[variant].characters, 0), lines: rows.reduce((sum, row) => sum + row[variant].lines, 0) }]));
  return { rows, total, reductionPercent: 100 * (1 - total.lean.characters / total.default.characters), details };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = budget();
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('Source\tDefault chars\tDefault lines\tLean chars\tLean lines');
    for (const row of [...report.rows, { source: 'total', ...report.total }]) console.log([row.source, row.default.characters, row.default.lines, row.lean.characters, row.lean.lines].join('\t'));
    console.log(`Reduction: ${report.reductionPercent.toFixed(2)}%`);
    if (process.argv.includes('--details')) for (const variant of variantsForDetails(report)) console.log(variant);
  }
}

function variantsForDetails(report) {
  return Object.entries(report.details).flatMap(([variant, groups]) => Object.entries(groups).flatMap(([group, entries]) => entries.map(entry => `${variant}\t${group}\t${entry.source}\t${entry.characters}\t${entry.lines}`)));
}

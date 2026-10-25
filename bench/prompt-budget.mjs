import { upfrontAsk, remoteApprovalNotice, physicalApprovalNotice } from '../plugins/sleight/lib/remote-approvals.mjs';
// Offline inventory of sleight's prompt sources. No engine or host helper is started.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import ts from 'typescript';
import { skillRules, localToolDefinitions } from '../plugins/sleight/lib/launch.mjs';
import { batchingDescription, createRelay, promptNotice, promptTool } from '../plugins/sleight/lib/relay.mjs';
import { NATIVE_HANDOFF_TOOL } from '../plugins/sleight/lib/native-handoff.mjs';
import { FLOW_TOOL } from '../plugins/sleight/lib/flow-rules.mjs';
import { engineBrowserOpen, engineOpenTool, withBrowserOpenFirst } from '../plugins/sleight/lib/engine-browser-open.mjs';

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
    return [...localToolDefinitions({ SLEIGHT_PROMPT: prompt }), ...result.result.tools.filter(t => !['select_window'].includes(t.name)), promptTool(FLOW_TOOL, prompt),
      // Document mode doesn't advertise app_handoff, so count it from its definition.
      promptTool(NATIVE_HANDOFF_TOOL, prompt)];
  } finally {
    relay.dispose();
    for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy();
  }
}

function descriptions(value, path = '') {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => key === 'description' ? [{ path, text: item }] : descriptions(item, `${path}.${key}`));
}

// Authored text with interpolated values as <value>: each branch of a choice on its own line, and a
// promptNotice call in its SLEIGHT_PROMPT wording.
function renderer(ast, prompt) {
  return function render(node) {
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
  };
}

// Each authored result template is counted once, including inactive safety paths.
// Interpolated UI data is represented by <value>. Engine docs, screenshots and UI trees vary by run.
export function noticeInventory(prompt, source = readFileSync(new URL('../plugins/sleight/lib/relay.mjs', import.meta.url), 'utf8')) {
  const ast = ts.createSourceFile('relay.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const entries = [], render = renderer(ast, prompt);
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
    if (ts.isFunctionDeclaration(node) && ['openMenuNote', 'selectionRecovery', 'confirmRecovery', 'reportPreapprovals', 'requireNote'].includes(node.name?.text)) {
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
    'browser-call.mjs': ['browserLeaseNote'],
    'read-failure.mjs': ['savePanelNote', 'offSpaceNote', 'readFailureAdvice'],
    'simulator-focus.mjs': ['simulatorScreenshotNote'],
    'blocked-apps.mjs': ['forbiddenTargetWarning'],
    'checked-stop.mjs': ['stopText'],
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
      const text = ['read-failure.mjs', 'simulator-focus.mjs', 'browser-call.mjs', 'checked-stop.mjs', 'clipboard.mjs'].includes(file) ? promptNotice(raw, prompt) : raw;
      if (text.replaceAll('<value>', '').trim()) entries.push({ path: `${file}:${ast.getLineAndCharacterOfPosition(node.getStart()).line + 1}`, text });
    };
    function visit(node, selected = false) {
      if (ts.isFunctionDeclaration(node)) selected = functions[file]?.includes(node.name?.text);
      if (selected && ts.isReturnStatement(node) && node.expression) add(node.expression);
      if (ts.isVariableDeclaration(node) && node.initializer && selected && ['recovery', 'reason', 'kind'].includes(node.name.getText(ast))) add(node.initializer);
      if (file === 'clipboard.mjs' && ts.isCallExpression(node) && node.expression.getText(ast) === 'notice') add(node.arguments[0]);
      ts.forEachChild(node, child => visit(child, selected));
    }
    visit(ast);
  }
  return entries;
}

// Text a lib module marks as model-visible: an expression after a /* notice */ comment (or /* lean notice */
// where sleight passes the text through promptNotice later), and in a template
// after a /* generated code */ comment (code sleight sends to the engine), each Error, stop or nodeRepl.write
// text. Notices the inventories above find carry no mark. Identical texts count once.
const libDir = new URL('../plugins/sleight/lib/', import.meta.url);
// The mark sits in the trivia just before the expression (TypeScript calls a same-line comment trailing).
const markedBy = (source, node, mark) => node.pos < node.end && source.slice(node.pos, node.getStart()).trimEnd().endsWith(mark);
const VALUE = '__sleightBudgetValue__';
export function taggedNoticeInventory(prompt) {
  const entries = [], seen = new Set();
  for (const file of readdirSync(libDir).filter(name => /\.m?js$/.test(name)).sort()) {
    const source = readFileSync(new URL(file, libDir), 'utf8');
    if (!/\/\* (?:lean )?notice \*\/|\/\* generated code \*\//.test(source)) continue;
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), render = renderer(ast, prompt);
    const line = node => ast.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const add = (text, at) => {
      if (!text.replaceAll('<value>', '').trim()) throw new Error(`${file}:${at}: a marked notice has no authored text`);
      if (!seen.has(text)) { seen.add(text); entries.push({ path: `${file}:${at}`, text }); }
    };
    function generated(template) {
      const code = ts.isTemplateExpression(template) ? template.head.text + template.templateSpans.map(span => VALUE + span.literal.text).join('') : template.text;
      const inner = ts.createSourceFile('generated.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), renderInner = renderer(inner, prompt);
      (function visit(node) {
        if (markedBy(code, node, '/* notice */')) return add(renderInner(node).replaceAll(VALUE, '<value>'), line(template) + inner.getLineAndCharacterOfPosition(node.getStart()).line);
        if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ['Error', 'stop', 'nodeRepl.write'].includes(node.expression.getText(inner)) && node.arguments?.[0]) {
          const text = renderInner(node.arguments[0]).replaceAll(VALUE, '<value>');
          if (text.replaceAll('<value>', '').trim() && !text.startsWith('[sleight:') && !seen.has(text)) {
            seen.add(text); entries.push({ path: `${file}:${line(template) + inner.getLineAndCharacterOfPosition(node.getStart()).line}`, text });
          }
        }
        ts.forEachChild(node, visit);
      })(inner);
    }
    (function visit(node) {
      if (markedBy(source, node, '/* notice */')) return add(render(node), line(node));
      if (markedBy(source, node, '/* lean notice */')) return add(promptNotice(render(node), prompt), line(node));
      if ((ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) && markedBy(source, node, '/* generated code */')) generated(node);
      ts.forEachChild(node, visit);
    })(ast);
  }
  return entries;
}

// The CLI inherits feature flags from the shell; use budget({}) for the pinned default inventory.
export function budget(env = process.env) {
  const browserCore = engineBrowserOpen(env);
  const variants = ['default', 'lean'];
  const rows = ['skill', 'tool descriptions', 'js rewrite', 'relay notices', 'shared notices', 'marked notices'].map(source => ({ source }));
  const details = {};
  for (const variant of variants) {
    const prompt = variant === 'lean' ? 'lean' : undefined;
    const toolEntries = [...tools(prompt), ...(browserCore ? [engineOpenTool(prompt)] : [])].flatMap(tool => descriptions(tool, tool.name));
    const notices = noticeInventory(prompt), shared = sharedNoticeInventory(prompt), marked = taggedNoticeInventory(prompt);
    const metadata = readFileSync(skillPath, 'utf8').match(/^---\n[\s\S]*?\n---\n+/)[0];
    const texts = [metadata + skillRules(skillPath, { SLEIGHT_PROMPT: prompt }), toolEntries.map(e => e.text).join('\n'),
      (browserCore ? withBrowserOpenFirst : text => text)(batchingDescription(firstRule, true, prompt)), notices.map(e => e.text).join('\n'), shared.map(e => e.text).join('\n'),
      marked.map(e => e.text).join('\n')];
    rows.forEach((row, i) => { row[variant] = size(texts[i]); });
    details[variant] = { tools: toolEntries.map(e => ({ source: e.path, ...size(e.text) })), notices: notices.map(e => ({ source: e.path, ...size(e.text) })), shared: shared.map(e => ({ source: e.path, ...size(e.text) })),
      marked: marked.map(e => ({ source: e.path, ...size(e.text) })) };
  }
  const total = Object.fromEntries(variants.map(variant => [variant, { characters: rows.reduce((sum, row) => sum + row[variant].characters, 0), lines: rows.reduce((sum, row) => sum + row[variant].lines, 0) }]));
  const upfront = upfrontAsk([{ name: 'Mail' }, { name: 'Word' }]), refusal = remoteApprovalNotice('TextEdit');
  const conditional = { remoteApprovals: { ordinary: size(''),
    upfront: { text: upfront, ...size(upfront) }, refusal: { text: refusal, ...size(refusal) }, physical: { text: physicalApprovalNotice, ...size(physicalApprovalNotice) } } };
  return { rows, total, conditional, reductionPercent: 100 * (1 - total.lean.characters / total.default.characters), details };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = budget();
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('Source\tDefault chars\tDefault lines\tLean chars\tLean lines');
    for (const row of [...report.rows, { source: 'total', ...report.total }]) console.log([row.source, row.default.characters, row.default.lines, row.lean.characters, row.lean.lines].join('\t'));
    console.log(`Reduction: ${report.reductionPercent.toFixed(2)}%`);
    console.log(`Conditional remote approvals: ordinary ${report.conditional.remoteApprovals.ordinary.characters} chars; upfront ${report.conditional.remoteApprovals.upfront.characters}; refusal ${report.conditional.remoteApprovals.refusal.characters}; physical ${report.conditional.remoteApprovals.physical.characters} (app names vary).`);
    if (process.argv.includes('--details')) for (const variant of variantsForDetails(report)) console.log(variant);
  }
}

function variantsForDetails(report) {
  return Object.entries(report.details).flatMap(([variant, groups]) => Object.entries(groups).flatMap(([group, entries]) => entries.map(entry => `${variant}\t${group}\t${entry.source}\t${entry.characters}\t${entry.lines}`)));
}

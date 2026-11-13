import { parseScript } from '../../vendor/meriyah/dist/meriyah.min.mjs';

// Parse the original cell first, so duplicate declarations within a cell and
// every other syntax error still refuse before anything can run. Only direct
// program-body declarations receive persistent REPL rebinding semantics.
export function rebindCell(code, declared) {
  const options = { next: true, ranges: true, lexical: true, webcompat: true };
  let ast, offset = 0;
  try { ast = parseScript(code, options); }
  catch (error) {
    // Node's REPL also accepts top-level await in otherwise sloppy scripts.
    // Parse those cells as an async body without imposing module strictness.
    const prefix = 'async function __cell__(){\n';
    try {
      const source = prefix + code + '\n}', program = parseScript(source, options), wrapper = program.body[0];
      if (program.body.length !== 1 || wrapper?.type !== 'FunctionDeclaration' ||
          wrapper.start !== 0 || wrapper.end !== source.length ||
          wrapper.body.start !== prefix.length - 2 || wrapper.body.end !== source.length) throw error;
      ast = wrapper.body; offset = prefix.length;
    }
    catch { throw error; }
  }
  const slice = node => code.slice(node.range[0] - offset, node.range[1] - offset);
  const edits = [], names = new Set(declared);
  const bindings = pattern => pattern.type === 'Identifier' ? [pattern.name] : pattern.type === 'RestElement' ? bindings(pattern.argument) :
    pattern.type === 'AssignmentPattern' ? bindings(pattern.left) : pattern.type === 'ArrayPattern' ? pattern.elements.filter(Boolean).flatMap(bindings) :
      pattern.type === 'ObjectPattern' ? pattern.properties.flatMap(p => bindings(p.type === 'RestElement' ? p.argument : p.value)) : [];
  for (let node of ast.body) {
    if (node.type === 'VariableDeclaration' && node.kind === 'var')
      for (const d of node.declarations) for (const name of bindings(d.id)) names.add(name);
    if (['FunctionDeclaration', 'ClassDeclaration'].includes(node.type) && node.id) names.add(node.id.name);
    if (node.type !== 'VariableDeclaration' || !['let', 'const'].includes(node.kind)) continue;
    const replacements = node.declarations.map(d => {
      const bound = bindings(d.id), fresh = bound.filter(name => !declared.has(name));
      for (const name of bound) names.add(name);
      const pattern = slice(d.id), existing = fresh.length < bound.length;
      const value = d.init ? slice(d.init) : 'undefined';
      if (!existing) return `let ${pattern}${d.init ? ` = (${value})` : ''};`;
      const declarations = fresh.length ? `let ${fresh.join(', ')};\n` : '';
      return declarations + `(${pattern} = (${value}));`;
    });
    edits.push({ start: node.range[0] - offset, end: node.range[1] - offset, text: replacements.join('\n') });
  }
  for (const edit of edits.reverse()) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  return { code, names };
}

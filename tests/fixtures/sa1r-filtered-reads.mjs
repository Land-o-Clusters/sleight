// Pure read forms from the SA1H review. These strings are classified, never run.
export const parenthesizedReads = [
  ['slice', 'nodeRepl.write((await app.getAXState()).slice(0, 100));'],
  ['includes', 'nodeRepl.write((await app.getAXState()).includes("TextEditor"));'],
  ['filter', 'nodeRepl.write((await app.getAXState()).filter(x => x));'],
  ['split-filter-join', 'nodeRepl.write((await app.getAXState()).split("\\n").filter(line => line.includes("Row 7")).join("\\n"));'],
  ['emit-false', 'nodeRepl.write((await note.getAXState({ emit: false })).includes("TextEditor"));'],
  ['unused-declaration', 'const unused = [1,2].filter(x => x); nodeRepl.write((await app.getAXState()).slice(0,100));'],
  ['unused-and-chain', 'const unused = [1,2].filter(x => x); nodeRepl.write((await app.getAXState({ emit: false })).split("\\n").filter(line => line.includes("Row 7")).join("\\n"));'],
  ['nested-parentheses', 'nodeRepl.write(((await app.getAXState())).slice(0, 100));'],
];
export const stateReads = [
  ['bound-state', 'const s = await app.getAXStateAndScreenshot(); nodeRepl.write(s.state.split("\\n").slice(0, 6).join("\\n"));'],
  ['inline-state', 'nodeRepl.write((await app.getAXStateAndScreenshot({ emit: false })).state.split("\\n").filter(line => line.includes("Row 7")).join("\\n"));'],
];

// The README's shape: the three blocks bench/results-hub.mjs writes appear once each, in order, and the hand-written
// text around them stays under 110 lines. INSTALL.md exists and the README links it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const readme = readFileSync(new URL('README.md', root), 'utf8');
const BLOCKS = ['hub:claim', 'hub:headline', 'hub:benchmarks'];

const count = (text, needle) => text.split(needle).length - 1;

test('release docs contain no validation placeholders or pending host markers', {
  skip: process.env.SLEIGHT_ALLOW_RELEASE_TODO === '1',
}, () => {
  const pending = ['README.md', 'INSTALL.md', 'CHANGELOG.md', 'docs/other-hosts.md',
    'docs/known-problems.md', 'docs/privacy.md', 'docs/settings.md', 'docs/grokbot-skill.md'].filter(file => {
    const doc = readFileSync(new URL(file, root), 'utf8');
    return /TODO\(1\.4\.0-validation\)|<!-- GB14|<!-- GB12|^## 1\.4\.0 \(TODO:/m.test(doc);
  });
  assert.deepEqual(pending, [], 'these files still need release validation');
});

test('each generated block appears once, opened before it is closed, in the planned order', () => {
  let last = -1;
  for (const name of BLOCKS) {
    assert.equal(count(readme, `<!-- ${name} -->`), 1, `${name} opens once`);
    assert.equal(count(readme, `<!-- /${name} -->`), 1, `${name} closes once`);
    const open = readme.indexOf(`<!-- ${name} -->`), close = readme.indexOf(`<!-- /${name} -->`);
    assert.ok(open < close, `${name} opens before it closes`);
    assert.ok(open > last, `${name} follows the block before it`);
    last = close;
  }
});

test('the README is under 110 lines outside the generated blocks', () => {
  let inside = false, outside = 0;
  for (const line of readme.trimEnd().split('\n')) {
    const marker = BLOCKS.find(name => line.trim() === `<!-- ${name} -->` || line.trim() === `<!-- /${name} -->`);
    if (marker) { inside = !line.includes('/hub:'); continue; }
    if (!inside) outside++;
  }
  assert.ok(outside < 110, `${outside} hand-written lines`);
});

test('the first screen explains the app, requirements and setup limits before the demo and claim', () => {
  const demo = readme.indexOf('src="docs/assets/demo.gif"');
  assert.ok(demo > readme.indexOf('ChatGPT desktop app'));
  assert.ok(demo > readme.indexOf('fresh macOS user'));
  assert.ok(demo < readme.indexOf('<!-- hub:claim -->'));
  assert.ok(readme.indexOf('<!-- hub:claim -->') < readme.indexOf('## Install'));
  assert.ok(readme.indexOf('## Install') < readme.indexOf('## Where it runs'));
});

test('the opening claim has three lines and sends benchmark details to the hub', () => {
  const claim = readme.split('<!-- hub:claim -->')[1].split('<!-- /hub:claim -->')[0].trim().split('\n');
  assert.equal(claim.length, 3);
  assert.match(claim[0], /sleight's own.*native Mac benchmark/);
  assert.match(claim[0], /<br>$/);
  assert.match(claim[1], /^Expected time is .*pass rate.*failed attempts are retried\.<br>$/);
  assert.match(claim[2], /\[Benchmark hub\]\(docs\/results\/README\.md\)/);
  assert.doesNotMatch(claim.join('\n'), /claude-haiku|gpt-6-luna|engine 26\.|Earlier Opus/);
});

test('the ChatGPT app is required without requiring its account or sign-in', () => {
  assert.match(readme, /ChatGPT desktop app[^\n]*is required in `\/Applications`/);
  assert.match(readme, /You don't need a ChatGPT account or sign-in/);
});

test('Turbo explains consent, dated results, the existing chart and user controls', () => {
  const turbo = readme.split('## Turbo\n')[1]?.split('\n## ')[0];
  assert.ok(turbo, 'the Turbo section exists');
  assert.match(turbo, /Chrome and Helium directly/);
  assert.match(turbo, /one-time debugging switch/);
  assert.match(turbo, /Chrome.*12 of 13.*296\.8 s.*447\.8 s.*2026-10-18 to 2026-10-19/);
  assert.match(turbo, /Helium.*10 of 13.*264\.1 s.*343\.6 s.*2026-10-18 to 2026-10-19/);
  assert.match(turbo, /docs\/results\/browser-turbo\.md/);
  assert.match(turbo, /docs\/results\/img\/family-browser-turbo-chrome-light\.svg/);
  assert.match(turbo, /`\.\/bin\/sleight-mcp turbo on`/);
  assert.match(turbo, /`\.\/bin\/sleight-mcp turbo on --browser helium`/);
  assert.match(turbo, /`\.\/bin\/sleight-mcp turbo off`/);
  assert.match(turbo, /From the installed plugin folder, you run/);
});

test('INSTALL.md exists, the README links it, and it names the steps only the user can do', () => {
  assert.ok(existsSync(new URL('INSTALL.md', root)));
  assert.match(readme, /\]\(INSTALL\.md\)/);
  const install = readFileSync(new URL('INSTALL.md', root), 'utf8');
  for (const step of [/administrator/, /Accessibility and Screen Recording/, /Always allow/, /chrome:\/\/inspect\/#remote-debugging/])
    assert.match(install, step);
  assert.match(install, /^# Installing sleight\n\nCoding agents: \[read Agent notes first\]\(#agent-notes\)\./);
  assert.match(install, /Don't run `sudo` or `sleight-mcp setup`/);
  assert.match(install, /Give the user this setup command to run from the same plugin folder:/);
});

test('the README carries the agent prompt on a line of its own, as the plan writes it', () => {
  // bench/agent-install.mjs reads the prompt from this line.
  assert.match(readme, /^Install sleight from https:\/\/github\.com\/Land-o-Clusters\/sleight and check it with its doctor\.$/m);
});

test("INSTALL.md's shell commands find the plugin through the host's listing and stay plain", () => {
  // The agent-install sandbox can't read ~/.claude or ~/.codex, and its allowlist refuses scripts, substitutions and if blocks.
  const install = readFileSync(new URL('INSTALL.md', root), 'utf8');
  const shell = [...install.matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1]).join('');
  assert.ok(shell.length > 0);
  for (const line of shell.trim().split('\n')) {
    assert.doesNotMatch(line, /\$\(|`|^\s*(if|then|for|while|do)\b|\b(bash|sh|zsh|node|python3?)\s+-c\b|&&|\|\|/, line);
    assert.doesNotMatch(line, /~\/\.(claude|codex)\b/, line);
  }
  assert.match(shell, /^claude plugin list --json$/m);
  assert.match(shell, /^codex plugin list --json$/m);
  assert.ok(shell.includes('${CODEX_HOME:-$HOME/.codex}/plugins/'));
  assert.doesNotMatch(shell, /"\$CODEX_HOME\//);
});

test('the hosts table carries a Cursor row, switched off inside the cursor-row comment or switched on', () => {
  // Until Cursor's first live install passes, the row sits in an HTML comment right after the table's last row, so
  // deleting the comment's two marker lines adds it to the table.
  const table = readme.slice(readme.indexOf('## Where it runs'), readme.indexOf('<!-- hub:headline -->'));
  assert.match(table, /^\| Cursor \|/m);
  const off = /<!-- cursor-row:[^\n]*\n\| Cursor \|[^\n]*\n-->/.test(table);
  const on = !table.includes('cursor-row') && /^\| Other MCP clients \|[^\n]*\n\| Cursor \|/m.test(table);
  assert.ok(off || on, 'the Cursor row is either wholly inside the cursor-row comment or a plain table row');
});

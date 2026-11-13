// Reproduce the review's offline differentials, including its deliberately
// inconsistent footer renumberings. No engine, app, browser or ledger access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { engineConsent } from '../plugins/sleight/lib/consent-wall.mjs';
import { allSegments, completeSegments, insertions, baseConsent } from './sa2m-fixtures.mjs';
const verdict = r => r?.blocked ? (/could not be verified/.test(r.why ?? '') ? 'unverifiable' : 'blocked') : r?.decline ? 'decline' : 'pass';
const compare = (text, id) => [verdict(baseConsent('click', [id], text)), verdict(engineConsent('click', [id], text))];

test('review sparse insertions preserve all 2823 body clicks', t => {
  let cases = 0, changes = 0, blockToPass = 0;
  for (const item of insertions) {
    const wallIds = new Set([item.accept - 2, item.accept - 1, item.accept, item.reject]);
    for (const line of item.text.split('\n')) {
      const m = /^\t*(\d+) /.exec(line);
      if (!m || wallIds.has(Number(m[1]))) continue;
      const [before, after] = compare(item.text, Number(m[1]));
      cases++;
      if (before !== after) changes++;
      if (before !== 'pass' && after === 'pass') blockToPass++;
    }
  }
  t.diagnostic(JSON.stringify({ cases, changes, blockToPass }));
  assert.deepEqual({ cases, changes, blockToPass }, { cases: 2823, changes: 0, blockToPass: 0 });
});

test('review walls in all 77 segments preserve 5970 gated verdicts', t => {
  const counts = { cases: 0, same: 0, blockToPass: 0, rejectLost: 0, acceptUnverifiable: 0 };
  const complete = new Set(completeSegments);
  const per = { complete: { cases: 0, changes: 0 }, partial: { cases: 0, changes: 0 } };
  const differences = {};
  for (const tree of allSegments) {
    const indices = [];
    tree.lines.forEach((line, i) => {
      const m = /^(\t*)(\d+) /.exec(line);
      if (m) indices.push([i, m[1].length, Number(m[2])]);
    });
    const step = Math.max(1, Math.floor(indices.length / 12));
    for (let k = 0; k < indices.length; k += step) for (const extra of [0, 1]) {
      const [pos, depth, id] = indices[k], d = depth + extra;
      if (!d) continue;
      const tabs = '\t'.repeat(d);
      const lines = tree.lines.slice(0, pos + 1).concat(tree.lines.slice(pos + 1).map(line => {
        const m = /^(\t*)(\d+) (.*)$/.exec(line);
        return m && !(m[1].length === 0 && Number(m[2]) === 0) ? m[1] + (Number(m[2]) + 4) + ' ' + m[3] : line;
      }));
      lines.splice(pos + 1, 0, tabs + (id + 1) + ' dialog', tabs + '\t' + (id + 2) + ' text We use cookies',
        tabs + '\t' + (id + 3) + ' button Accept all', tabs + '\t' + (id + 4) + ' button Reject all');
      for (const [kind, target] of [['accept', id + 3], ['reject', id + 4], ['other', id + 5]]) {
        const [before, after] = compare(lines.join('\n'), target);
        if (/^(?:glc[12]|gls4)-calculator-/.test(tree.src)) assert.equal(after, before, `${tree.src}: ${kind} at ${id}`);
        const part = per[complete.has(tree) ? 'complete' : 'partial'];
        counts.cases++; part.cases++;
        if (before === after) counts.same++;
        else {
          part.changes++;
          const key = tree.src + ': ' + before + ' to ' + after;
          differences[key] = (differences[key] ?? 0) + 1;
        }
        if (before !== 'pass' && after === 'pass') counts.blockToPass++;
        if (kind === 'reject' && before === 'decline' && after !== 'decline') counts.rejectLost++;
        if (kind === 'accept' && after === 'unverifiable') counts.acceptUnverifiable++;
      }
    }
  }
  t.diagnostic(JSON.stringify({ counts, per, differences }));
  // SA2T adds safari-site-depth4.json: one 6-row segment, 11 wall positions and 33 verdicts.
  // GLC1/GLC2 add 147 wall verdicts in two Calculator segments. Their base
  // and current verdicts agree; the original 5673 verdicts remain covered.
  // GLS4 adds 150 wall verdicts from two recorded Calculator trees.
  assert.equal(allSegments.length, 77);
  assert.equal(counts.cases, 5970);
  assert.equal(counts.same, 5631);
  assert.equal(counts.blockToPass, 0);
});

test('review 13316 spelled-line mutations preserve every base block or decline', t => {
  const dense = ['0 standard window Fixture', '\t1 HTML content Fixture', '\t\t2 dialog', '\t\t\t3 text We use cookies',
    '\t\t\t4 button Accept all', '\t\t\t5 button Reject all', '\t\t6 text Article', '\t\t7 button Read recipe'];
  const sparse = ['0 standard window Fixture', '\t1 HTML content Fixture', '\t\t2 dialog', '\t\t\t3 text We use cookies',
    '\t\t\t6 button Accept all', '\t\t\t9 button Reject all', '\t\t12 text Article', '\t\t14 button Read recipe'];
  const bodies = ['text x', 'button Reject all', 'button Accept all', 'menu bar', 'dialog', 'standard window Fake', 'group x', 'text We use cookies'];
  const ids = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 13, 99];
  const counts = { cases: 0, blockToPass: 0, rejectDeclineToUnverifiable: 0, changes: 0 };
  const residuals = [];
  function run(label, lines, accept, reject) {
    const text = lines.join('\n');
    for (const [kind, id] of [['accept', accept], ['reject', reject]]) {
      const [before, after] = compare(text, id);
      counts.cases++;
      if (before !== after) counts.changes++;
      if (before !== 'pass' && after === 'pass') counts.blockToPass++;
      if (kind === 'accept' && after === 'pass') residuals.push({ label, before });
      if (kind === 'reject' && before === 'decline' && after === 'unverifiable') counts.rejectDeclineToUnverifiable++;
    }
  }
  for (const [name, tree, accept, reject] of [['dense', dense, 4, 5], ['sparse', sparse, 6, 9]]) {
    run(name + ' plain', tree, accept, reject);
    for (let pos = 1; pos <= tree.length; pos++) for (const tabs of [0, 1, 2, 3]) for (const body of bodies) for (const id of ids) {
      const line = '\t'.repeat(tabs) + id + ' ' + body;
      run(`${name} pos${pos} tabs${tabs} id${id} ${body}`, [...tree.slice(0, pos), line, ...tree.slice(pos)], accept, reject);
    }
  }
  t.diagnostic(JSON.stringify({ counts, residuals }));
  assert.equal(counts.cases, 13316);
  assert.equal(counts.blockToPass, 0);
  assert.equal(residuals.length, 16);
  assert.ok(residuals.every(r => r.before === 'pass' && /^sparse pos4 tabs[12] id[45] /.test(r.label)));
});

test('coherent walls on complete reads preserve honest Reject and necessary-only input', t => {
  let walls = 0, withFooter = 0, acceptBlocks = 0, rejectDeclines = 0, necessaryDeclines = 0;
  for (const tree of completeSegments) {
    const footer = tree.lines.indexOf('Selected:');
    const primary = footer < 0 ? tree.lines : tree.lines.slice(0, footer);
    const indices = [];
    primary.forEach((line, i) => {
      const m = /^(\t*)(\d+) /.exec(line);
      if (m) indices.push([i, m[1].length, Number(m[2])]);
    });
    const step = Math.max(1, Math.floor(indices.length / 12));
    for (let k = 0; k < indices.length; k += step) for (const extra of [0, 1]) {
      const [pos, depth, id] = indices[k], d = depth + extra;
      if (!d) continue;
      // Renumber an echo according to its original row, wherever that row is.
      const renumber = line => line.replace(/^(\t*)(\d+) /,
        (whole, tabs, n) => Number(n) > id ? tabs + (Number(n) + 4) + ' ' : whole);
      const lines = tree.lines.map(renumber), tabs = '\t'.repeat(d);
      lines.splice(pos + 1, 0, tabs + (id + 1) + ' dialog', tabs + '\t' + (id + 2) + ' text We use cookies',
        tabs + '\t' + (id + 3) + ' button Accept all', tabs + '\t' + (id + 4) + ' button Reject all');
      const text = lines.join('\n');
      // Some anchors absorb a large existing subtree into the inserted dialog.
      // Base's 1500-character limit does not classify those as cookie walls.
      for (const [target, observed] of [[id + 3, text], [id + 4, text],
        [id + 4, text.replace('button Reject all', 'button Use necessary cookies only')]]) {
        assert.equal(verdict(engineConsent('click', [target], observed)), verdict(baseConsent('click', [target], observed)), tree.src);
      }
      if (engineConsent('click', [id + 3], text)?.blocked) acceptBlocks++;
      if (engineConsent('click', [id + 4], text)?.decline) rejectDeclines++;
      if (engineConsent('click', [id + 4], text.replace('button Reject all', 'button Use necessary cookies only'))?.decline) necessaryDeclines++;
      walls++;
      if (footer >= 0) withFooter++;
    }
  }
  t.diagnostic(JSON.stringify({ walls, withFooter, acceptBlocks, rejectDeclines, necessaryDeclines }));
  assert.ok(withFooter > 0, 'the availability census must include real footer echoes');
  assert.equal(rejectDeclines, acceptBlocks);
  assert.equal(necessaryDeclines, acceptBlocks);
});

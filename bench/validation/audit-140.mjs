// Read-only inventory. This module never imports a live runner or prepares fixtures.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTasks } from '../tasks.mjs';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const EVIDENCE = join(homedir(), 'Projects/sleight-wt/race-1017');
export const HARNESS_PATHS = ['bench', 'scripts', 'package.json', 'package-lock.json'];
export const NATIVE = 'textedit-edit,finder-rename,finder-create-folder,textedit-two-windows,textedit-window-drag,textedit-replace-save,textedit-insert-line,word-memo,word-brief,textedit-notes-table'.split(',');
export const sha = value => createHash('sha256').update(value).digest('hex');
export const git = (...args) => execFileSync('/usr/bin/git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const json = path => JSON.parse(readFileSync(path, 'utf8'));
export const source = (build, path) => git('show', `${build}:${path}`);
export function harness(build) {
  // Content-addressed file inventory, including fixtures, prompts, launch and grading code.
  const files = Object.fromEntries(git('ls-tree', '-r', build, '--', ...HARNESS_PATHS).trim().split('\n')
    .filter(line => line && !line.includes('\tbench/results/')).map(line => {
      const [meta, path] = line.split('\t'); return [path, meta];
    }));
  return { hash: sha(JSON.stringify(files)), files };
}

export function inventory({ evidence = EVIDENCE, build = 'HEAD' } = {}) {
  const bBuild = git('rev-parse', `${build}^{commit}`).trim();
  if (bBuild !== git('rev-parse', 'HEAD').trim()) throw Error('Run the planner from the requested B build so prompt templates match its sources');
  const bHarness = harness(bBuild), harnesses = {}, rounds = [], problems = [];
  // Only call pure prompt functions with placeholders. Never call prepare, setup, check or cleanup.
  const ctx = { dir: '{dir}', nonce: '{nonce}', document: '{document}', documents: ['{source}', '{target}'], folder: '{folder}', officePath: '{officePath}' };
  const templates = Object.fromEntries(getTasks('world').filter(t => NATIVE.includes(t.id)).map(t => [t.id, t.prompt(ctx)]));
  const add = (name, kind, file, flags = {}) => {
    try {
      const raw = json(file), native = kind === 'native', dir = native ? null : file.slice(0, -'/results.json'.length);
      const c = native ? { build: raw.sleight, harness: raw.sleight } : json(join(dir, 'commits.json'));
      const engine = native ? raw.engine : json(join(dir, 'engine.json'));
      const rows = native ? raw.results : raw;
      const pin = c.harness.commit;
      harnesses[pin] ??= harness(pin);
      const promptSources = native ? Object.fromEntries(['bench/tasks.mjs', 'bench/world/tasks.mjs', 'bench/tasks-held-out.mjs']
        .map(path => [path, sha(source(pin, path))])) : undefined;
      rounds.push({ name, kind, path: file, fileHash: sha(readFileSync(file)), build: c.build.commit,
        harnessCommit: pin, harnessHash: harnesses[pin].hash, engine: engine.version, engineChanged: engine.changed,
        ...(native ? {} : { upstream: c.fowlbrowser, patchHash: sha(source(pin, 'bench/fowl/sleight-surface.patch')) }),
        clean: !c.build.dirty && !c.harness.dirty, flags,
        durationSeconds: (Date.parse(engine.endedAt) - Date.parse(engine.startedAt)) / 1000,
        tasks: rows.map(row => ({ task: native ? row.task : row.task.name,
          prompt: native ? null : row.task.prompt, promptHash: native ? null : sha(row.task.prompt),
          ...(native && { promptSources, currentPromptTemplate: templates[row.task], currentTemplateHash: sha(templates[row.task]),
            promptProvenance: 'Rendered A prompt absent. B template shown with placeholders; pinned A source hashes retained. No rendered A hash is inferred.' }),
          seconds: native ? row.seconds : row.wallMs / 1000,
          models: native ? row.models : Object.keys(row.run?.result?.modelUsage ?? {}),
          effort: native ? raw.effort : 'high', effortProvenance: native ? 'result file' : 'round command script',
          ...(native ? {} : { taskSpecHash: sha(JSON.stringify(row.task)), flags: row.agentConfig?.abFlags ?? null }),
        })) });
    } catch (error) { problems.push(`${name}: ${error.message}`); }
  };
  for (const fs of [0, 1]) for (let n = 1; n <= 3; n++) {
    const name = `native-fs6-${fs}-r${n}`;
    try {
      const log = readFileSync(join(evidence, `${name}.log`), 'utf8');
      const path = /^results: (.+)$/m.exec(log)?.[1];
      if (!path) throw Error('result path absent from log');
      add(name, 'native', path, { SLEIGHT_FS: String(fs) });
    } catch (error) { problems.push(`${name}: ${error.message}`); }
  }
  for (const br of ['safari', 'firefox']) for (const mode of ['off', 'on']) for (let n = 1; n <= 3; n++) {
    const name = `${br}-sleight-fs2${mode}-r${n}`;
    add(name, 'race', join(evidence, name, 'results.json'), { SLEIGHT_FS: mode === 'on' ? '1' : '0' });
    const as3 = `as3-${br}-${mode}-r${n}`;
    add(as3, 'as3', join(evidence, as3, 'results.json'), { SLEIGHT_BROWSER_CORE: mode === 'on' ? '1' : '0' });
  }
  for (const suffix of ['r1', 'opus-r1', 'r2', 'r3', 'r4', 'r5']) {
    const name = `chrome-sleight-turbo-rel131-${suffix}`;
    add(name, suffix === 'opus-r1' ? 'release-opus' : 'release-haiku', join(evidence, name, 'results.json'));
  }
  const currentTasks = json(join(ROOT, 'bench/world/tasks/fowlbrowser.json'));
  const as3Tasks = json(join(ROOT, 'bench/world/tasks/browser-open-heldout.json'));
  const current = [...currentTasks, ...as3Tasks];
  for (const round of rounds) {
    round.changedHarnessFiles = [...new Set([...Object.keys(harnesses[round.harnessCommit].files), ...Object.keys(bHarness.files)])]
      .filter(path => harnesses[round.harnessCommit].files[path] !== bHarness.files[path]);
    for (const task of round.tasks) {
      const now = current.find(row => row.name === task.task);
      task.currentPromptHash = now ? sha(now.prompt) : null;
      task.promptChanged = now && task.promptHash ? task.currentPromptHash !== task.promptHash : null;
      task.absentFromCurrentCatalog = !now && round.kind !== 'native';
      task.ownerRequiresBoth = task.task === 'demoid';
      task.needsBoth = !task.promptHash || task.promptChanged || task.absentFromCurrentCatalog || task.ownerRequiresBoth || round.harnessHash !== bHarness.hash;
    }
  }
  return { schema: 1, bBuild, bHarness, harnesses, rounds, problems,
    note: 'Historical flag cells are inventoried separately. Fresh release comparisons run product defaults, not a flag A/B.' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(a => a !== '--plan')) throw Error('Use --plan');
  console.log(JSON.stringify(inventory(), null, 2));
}

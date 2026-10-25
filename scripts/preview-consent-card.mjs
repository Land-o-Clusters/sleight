// Compile the production card in isolation, then render synthetic views without ordering any window onscreen.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export function previewConsentCards(directory) {
  mkdirSync(directory, { recursive: true });
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  const blocks = ['PERSON INPUT', 'APP FRAME', 'ASK CARD'].map(name => {
    const block = source.split(`// BEGIN ${name}\n`)[1]?.split(`// END ${name}`)[0];
    if (!block) throw new Error(`Missing production block: ${name}`);
    return block;
  });
  const fixture = readFileSync(new URL('../tests/fixtures/consent-card-layout.swift', import.meta.url), 'utf8');
  const path = join(directory, 'main.swift'), binary = join(directory, 'preview');
  writeFileSync(path, 'import AppKit\nimport Foundation\nimport CoreFoundation\nimport QuartzCore\nimport Carbon.HIToolbox\nimport ObjectiveC\nimport Darwin\nimport os.log\n' + blocks.join('\n') + '\n' + fixture);
  const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(directory, 'module-cache'), path, '-o', binary], { encoding: 'utf8', timeout: 120000 });
  if (build.status !== 0) throw new Error(`Compile failed (${build.status}): ${build.stderr}`);
  // This child never calls show/review, activates an app, or sends an approval. Collect its exit before returning.
  const run = spawnSync(binary, [directory, fileURLToPath(new URL('../plugins/sleight/assets/icon.png', import.meta.url))], { encoding: 'utf8', timeout: 30000 });
  if (run.status !== 0) throw new Error(`Preview failed (${run.status}): ${run.stderr}\n${run.stdout}`);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  return { ...JSON.parse(run.stdout), nativeSourceSHA256: hash(source), fixtureSHA256: hash(fixture), binarySHA256: hash(readFileSync(binary)) };
}

export function previewOrdinaryCards(directory) {
  mkdirSync(directory, { recursive: true });
  const source = readFileSync(new URL('../plugins/sleight/lib/ask.js', import.meta.url), 'utf8');
  const stop = source.indexOf('  // Center on the display under the pointer');
  if (stop < 0) throw new Error('Missing ordinary card display boundary');
  // Stop before activation, sound, timers and modal presentation. Only rasterize our synthetic content view.
  const fixture = source.slice(0, stop).replace('app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);',
    'app.setActivationPolicy($.NSApplicationActivationPolicyProhibited);') + `
  const renderView = panel.contentView;
  renderView.layoutSubtreeIfNeeded;
  const bitmap = renderView.bitmapImageRepForCachingDisplayInRect(renderView.bounds);
  renderView.cacheDisplayInRectToBitmapImageRep(renderView.bounds, bitmap);
  bitmap.representationUsingTypeProperties(4, $({})).writeToFileAtomically(argv[8], true);
  const buttons = [];
  for (let i = 0; i < content.subviews.count; i++) {
    const child = content.subviews.objectAtIndex(i);
    if (child.isKindOfClass($.NSButton)) buttons.push({ title: ObjC.unwrap(child.title), width: child.frame.size.width,
      intrinsicWidth: child.intrinsicContentSize.width, x: child.frame.origin.x, y: child.frame.origin.y });
  }
  return JSON.stringify({ width: W, height: H, visible: Boolean(panel.visible), buttons });
}
`;
  const path = join(directory, 'ordinary.js');
  writeFileSync(path, fixture);
  return ['approval', 'always', 'once', 'always-once', 'flow', 'review'].map(mode => {
    const scoped = ['approval', 'always'].includes(mode), always = ['always', 'always-once'].includes(mode);
    const run = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', path, 'Allow sleight to use TextEdit?',
      'Allow for this Claude Code session only.', fileURLToPath(new URL('../plugins/sleight/assets/icon.png', import.meta.url)), '60', ['flow', 'review'].includes(mode) ? mode : 'approval',
      'claude-code', always ? 'always' : '', scoped ? 'session' : 'once', join(directory, `jxa-${mode}.png`)], { encoding: 'utf8', timeout: 30000 });
    if (run.status !== 0) throw new Error(`Ordinary preview failed (${run.status}): ${run.stderr}`);
    return { mode, ...JSON.parse(run.stdout) };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = mkdtempSync(join(tmpdir(), 'sleight-card-preview-'));
  const result = previewConsentCards(directory);
  result.ordinary = previewOrdinaryCards(directory);
  writeFileSync(join(directory, 'geometry.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, cards: result.cards.map(({ name, frame }) => ({ name, frame })), ordinary: result.ordinary, answers: result.answers }, null, 2));
}

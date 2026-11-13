import { macProcessAncestry } from '../../plugins/sleight/lib/mac-safety.mjs';

// Kernel paths and plist identities only. No fixture reads the running Mac.
export const launcherChains = {
  Terminal: ['/opt/homebrew/Cellar/node/26/bin/node', '/fixture/.local/share/claude/versions/2.1.309', '/bin/zsh',
    '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'],
  Desktop: ['/opt/homebrew/Cellar/node/26/bin/node', '/bin/zsh',
    '/fixture/Library/Application Support/Claude/claude-code/2.1.309/hash/claude.app/Contents/MacOS/claude',
    '/Applications/Claude.app/Contents/Helpers/disclaimer', '/Applications/Claude.app/Contents/MacOS/Claude'],
  VSCode: ['/opt/homebrew/bin/node', '/fixture/.local/share/claude/versions/2.1.309', '/bin/zsh',
    '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)'],
  Codex: ['/opt/homebrew/bin/node', '/opt/homebrew/bin/codex', '/bin/zsh', '/Applications/iTerm.app/Contents/MacOS/iTerm2'],
};
export function bundleIdentity(plist) {
  if (plist.endsWith('/Visual Studio Code.app/Contents/Info.plist')) return 'com.microsoft.VSCode';
  if (plist.includes('Code Helper (Plugin).app')) return 'com.microsoft.VSCode.helper';
  if (plist.endsWith('/Claude.app/Contents/Info.plist')) return 'com.anthropic.claudefordesktop';
  if (plist.endsWith('/claude.app/Contents/Info.plist')) return 'com.anthropic.claude-code';
  if (plist.endsWith('/Terminal.app/Contents/Info.plist')) return 'com.apple.Terminal';
  if (plist.endsWith('/iTerm.app/Contents/Info.plist')) return 'com.googlecode.iterm2';
  throw Error('unreadable plist');
}
export function classifiedChain(paths, readBundleId = bundleIdentity) {
  return macProcessAncestry({ pid: 900, executable: pid => paths[900 - pid], readBundleId,
    run: (_file, args) => Number(args[1]) === 901 - paths.length ? '1' : String(Number(args[1]) - 1) });
}

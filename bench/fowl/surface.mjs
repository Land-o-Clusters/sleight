import path from 'node:path';

// Combined arm: FowlBrowser drives the tab, sleight drives Mac apps. agentSetup in the patched
// rounds.mjs loads this synchronously when --surface fowl+sleight.

export function fowlSleightSetup({ dir, mcpRoot, sleightRepo, label, remote = null, remoteDir, remoteServer }) {
  const fowl = {
    command: path.join(remote ? remote.bed : mcpRoot, 'mcp/bin/fowlbrowser-mcp'),
    env: { FOWLBROWSER_LABEL: label, FOWLBROWSER_RECORD: remote ? remoteDir : dir },
  };
  return {
    mcpServers: {
      fowlbrowser: remote ? remoteServer(fowl, { ssh: remote.ssh, dir: remoteDir }) : fowl,
      'plugin:sleight:computer': {
        command: path.join(sleightRepo, 'plugins/sleight/bin/sleight-mcp'),
        env: { SLEIGHT_SURFACES: 'computer', SLEIGHT_HAND: '0' },
      },
    },
    allowed: 'mcp__fowlbrowser,mcp__plugin_sleight_computer__js,mcp__plugin_sleight_computer__js_reset,mcp__plugin_sleight_computer__open_file,mcp__plugin_sleight_computer__app_handoff',
    promptPrefix: 'Use FowlBrowser (mcp__fowlbrowser) for the web page. When the task needs a Mac app, use mcp__plugin_sleight_computer__js.\n\n',
    pluginDir: path.join(sleightRepo, 'plugins/sleight'),
  };
}

export const usesSleightPlugin = (surface) => surface === 'sleight' || surface === 'fowl+sleight';

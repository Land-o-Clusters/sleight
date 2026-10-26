# Sharing sleight characters

A character pack is data that follows [character format v1](character-format.md). Share it in an installed
plugin or as one `.sleightchar` file. sleight's own protocol and format remain independent of any vendor's pets.
Codex v2 imports keep their atlas bytes; sleight supplies compatibility, never Codex pets or vendor art.
The ring marks the point. Imported sprites are hidden until the person selects sprite mode.

## Character plugins

Use this layout, with one folder per pack:

```text
my-characters/
  .claude-plugin/plugin.json
  .codex-plugin/plugin.json
  sleight-characters/
    my-character/
      character.json
      sheet.png
      extra.webp       (optional)
      perch.webp       (optional)
      preview.png      (optional)
      LICENSE.txt      (when the license needs it)
```

The Claude manifest identifies the plugin:

```json
{
  "name": "my-characters",
  "version": "1.0.0",
  "description": "Original characters for sleight.",
  "author": { "name": "Your name" },
  "license": "MIT"
}
```

Claude Code places this manifest in `.claude-plugin/`. Other files belong at the plugin root. `name` is
required. Bump `version` when distributing changed art, since an unchanged version keeps the cached copy.
These are [Claude Code's manifest rules](https://code.claude.com/docs/en/plugins-reference).

The character plugin's only payload is `sleight-characters/<id>/`. Its contents are art and metadata. sleight reads pack data without executing plugin code. A data-only plugin contains its manifests, character
folder and known metadata files. Unknown files or manifest keys make the picker group say
`warning: check plugin`. The import callout and `cursor list` name each unexpected item:
"Warning: this plugin includes hooks, MCP servers. sleight cannot control what the host loads from it."
The host may have loaded them before sleight opens its picker. This warning is a file and manifest check,
not an audit or a promise about the plugin's behavior.

Claude marketplaces can also declare inline components in their plugin entries. sleight checks that entry
through the host's `known_marketplaces.json` record when available. Missing component metadata produces
a warning too, since the plugin's own files alone cannot establish what the host loads.

### A marketplace

A Claude marketplace uses `.claude-plugin/marketplace.json`. Its `plugins` array names each plugin and
its source, with a relative source resolved from the marketplace root:

```json
{
  "name": "my-characters",
  "owner": { "name": "Your name" },
  "plugins": [{ "name": "example-bit", "source": "./plugins/example-bit" }]
}
```

People register the repository with `/plugin marketplace add OWNER/REPOSITORY`, then install
`/plugin install example-bit@my-characters`. They can register a local folder while developing it.
See [Create a marketplace](https://code.claude.com/docs/en/plugin-marketplaces).

Fork `examples/character-marketplace/` as a starting point. It contains a data-only Example Bit plugin,
derived from sleight's original Bit built-in. Its art bytes are unchanged, and its pack ID is `example-bit`.

### Discovery from install records

Claude Code records installs in `plugins/installed_plugins.json`, including `scope`, `installPath` and
`version`. Hosted marketplace installs normally live in `plugins/cache/<marketplace>/<plugin>/<version>/`;
local marketplace plugins can load in place. Enabled settings and installed records are separate from the
plugins loaded in a running session. See [Plugin loading reference](https://code.claude.com/docs/en/plugins/loading).

The `version: 2` record, its `projectPath` field and the `CLAUDE_CONFIG_DIR/plugins` root are observed
on this Mac, not documented host contracts. The default is `~/.claude/plugins`. The documented
`CLAUDE_CODE_PLUGIN_CACHE_DIR` override takes precedence. A user install is eligible everywhere.
Project and local installs are eligible within their recorded project. sleight chooses local scope over
project, then user scope, as its own precedence rule. Conflicting paths at the winning scope are refused. Disabled but still installed Claude
plugins remain available as art sources. sleight does not claim they are loaded or enable them.

Discovery follows only those recorded paths, never a general folder scan. Synced or session-only plugins
without install records are outside this adapter. Missing, unsupported or unsafe records do not expose packs.
The plugin root is resolved once and must stay under the user home, owned by that user. Refused roots
are listed with a reason. Children must stay under that resolved root or the recorded local marketplace.
Child symlinks, hardlinks, shared writable files and mismatched pack IDs are refused. Limits are 1 MiB per host
record, 256 plugin records, 32 entries in each plugin's character folder and 128 valid packs per catalog.

Each valid pack appears under the host-assigned `name@marketplace` identity. Choosing it rechecks its installed record and content
digest. Before installation and selection, sleight validates a captured copy through the host's sandboxed decoder.
Changing or uninstalling the plugin invalidates an outstanding offer. Installed local copies remain until
the person removes them. Plugin updates never silently replace a local character with the same ID.

### Codex compatibility

Codex supports `.codex-plugin/plugin.json` as a compatibility manifest. Its local marketplaces use
`.agents/plugins/marketplace.json`. A legacy `.claude-plugin/marketplace.json` is also recognized.
Installed copies live under `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`, with `local` used
for local installs. See [OpenAI's package documentation](https://developers.openai.com/plugins/build/plugins).

The template supplies a Codex compatibility manifest and a separate `.agents` marketplace catalog.
`codex plugin list --json` and its `installed[]` shape, including disabled installs, are observed on this
Mac and are not documented host contracts. The CLI versions checked on 2026-10-26 are Claude Code
2.1.309 and Codex 0.164.0. sleight asks that CLI for installed records and reads only the recorded version's cache path, or the documented `local` path for a local source. It never treats the
source checkout or an available but uninstalled listing as an installed plugin. `CODEX_HOME` is honored.
The CLI has a 3 s deadline and a 1 MiB output cap, and discovery skips Codex packs if the CLI is unavailable. Discovery runs
on a worker with a 10 s deadline and never runs on a computer-use action path. The Codex list is cached
for one menu open and reused during refresh and import revalidation. Its elapsed milliseconds are traced
as `hand-picker-codex-list`. A new menu open gets a new list. Claude records and pack bytes are rechecked.

This is a local marketplace integration. Public directory acceptance of a data-only plugin has not been
verified. Character plugins keep their data-only layout even if a host expects code or skills for directory acceptance.

## One-file packs

Run these from the person's terminal:

```sh
sleight-mcp cursor export example-bit ./example-bit.sleightchar
sleight-mcp cursor import ./example-bit.sleightchar
```

The launcher retains its person gate. Import shows the v1 size, license and generated fallback table and
asks for confirmation. `--yes` is the existing explicit CLI option. Import leaves the sprite hidden.
Export needs a stated license. It validates and decodes the snapshot before creating a new 0600 file.
It never overwrites an existing file. Import copies data into the private character bank through the existing atomic
installer. Existing IDs are refused. Packs with license `unknown` are accepted locally but cannot be shared.

`.sleightchar` v1 is an uncompressed POSIX ustar archive. Use flat, allowlisted filenames directly at its
root, with no enclosing folder. The reader uses only Node built-ins. It accepts at most 8 files with names up
to 80 bytes. The payload cap is 16 MiB. The whole-file cap adds 9 KiB for headers and padding. Per-file limits match v1:
manifest under 16 KiB, each sheet at most 8 MiB, preview at most 1 MiB, license at most 64 KiB.
The compression ratio is 1:1. Compressed archives are refused.

The reader verifies header checksums, bounded octal numbers, zero padding and two zero end blocks.
It rejects absolute and nested paths, traversal, links, directory entries, executable bits, duplicate
names, sparse files, PAX and GNU extensions, truncated files and trailing nonzero data. It never invokes
an archive program or honors archive ownership and permission fields. Extra zero end padding is allowed
within the whole-file cap.

The decoder checks a private temporary snapshot through `consent-host --check-character <bank>`, a mode
that draws nothing. This mode accepts only an owned 0700 canonical `/private/tmp/sleight-character-check-XXXXXX`
bank. Live rendering keeps its installed-path rule. The normal v1 file, dimension and pixel checks and
sandboxed image child apply. The temporary bank is removed after acceptance, refusal or cancellation of
the import prompt. A process crash can leave it behind. sleight keeps the source art unchanged and does not upload it.

## Making a character

Claude Code includes `/sleight:make-character`. The skill uses the generator in the matching sleight
source checkout at `tools/characters/`. There is one generator copy. Copy a cast design into your
project and run the checkout's builder with `--design` and a separate `--out` folder. It needs macOS `sips`, Node and `cwebp`.

OpenAI's [Build skills](https://learn.chatgpt.com/docs/build-skills) documents
`agents/openai.yaml` with `policy.allow_implicit_invocation: false` for explicit Codex invocation. It
does not document Claude Code's `disable-model-invocation` field. Support for that field in Codex is
unverified, so sleight's Codex manifest selects only `drive-mac-apps` and excludes `make-character`.

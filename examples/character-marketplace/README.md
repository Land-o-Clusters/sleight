# A character marketplace to fork

Copy this folder into a repository of your own. Change the marketplace's name and owner in both catalogs,
then replace `plugins/example-bit/sleight-characters/example-bit/` with your own v1 pack. Match its folder
name to the ID in `character.json`. Change the plugin name and version in both plugin manifests and
catalog entries. Keep your character license and attribution with the art.

Example Bit uses sleight's original Bit art under MIT, with the ID and display name changed. Its plugin
has no hooks, servers, skills, commands or agents. Extra animations and perch art are included.

In Claude Code, add the local folder with `/plugin marketplace add ./examples/character-marketplace`,
then `/plugin install example-bit@sleight-character-example`. For a hosted fork, use your repository's
`OWNER/REPOSITORY` in the add command. Open sleight's Cursor menu and choose the character under
`example-bit`. See the [sharing design](../../docs/design/character-sharing.md) for the host documentation,
discovery rules, warnings, archive format and limits.

For Codex, register the folder with `codex plugin marketplace add ./examples/character-marketplace`,
then install the plugin through the host's plugin directory. The `.agents` catalog and `.codex-plugin`
manifest are supplied for that path. Public directory acceptance of data-only plugins is unverified.

To make your own art, sleight includes the optional `/sleight:make-character` skill and its generator
template. Its description has a conservative bound below 60 tokens in `tests/prompt-budget.test.mjs`.
Publishing an official marketplace requires owner approval, so this folder prepares only local files.

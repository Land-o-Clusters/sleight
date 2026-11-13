# sleight character format v1

A character is a local folder of images and a `character.json` manifest. sleight includes Tsugi, Shizu, Bit, Kit, Yori and Tab, six original MIT characters. Codex pets and vendor art are never bundled.
The default cursor is sleight's ring. Importing a character leaves its sprite hidden. In overlay mode the sprite trails
that ring, which always marks the exact point. The sprite's anchor controls its offset. Rendering and style selection
are separate from importing.

The format belongs to sleight's open cursor protocol. Codex and Petdex pets in either supported layout import without changing their atlas bytes.
Character data remains on this Mac. Names and descriptions appear in the user CLI and picker, never in model prompts or tool results.

## Files

```text
my-character/
  character.json
  sheet.png          # or sheet.webp
  extra.webp         # optional extra rows (or extra.png)
  perch.webp         # optional perch-mode rows (or perch.png)
  preview.png        # optional, at most 256 by 256 pixels
  LICENSE.txt        # terms for a license the validator does not recognize
```

Installed folder names must equal the manifest's `id`. A source folder can have any name. `.DS_Store` is ignored and never
copied. Other files or subfolders are refused. This CLI accepts folders.
Archive extraction is outside this version of the importer. Do not put a `pet.json` beside `character.json`.

Imported characters install under `~/Library/Application Support/sleight/characters/<id>/`. Directories have mode 0700 and files
have mode 0600, owned by the current user. Sources must be user-owned, have no executable files and have no group or world
write permission. The importer resolves the source path first, so `/tmp` and download-folder aliases work. Symlinks inside
the source folder and hardlinked files are refused. Installed paths cannot contain symlinks. A wrong directory mode prints
a `chmod 700` command to fix it.

Renderers use the current user's fixed characters directory and the plugin's built-in packs. They ignore environment overrides. CLI tests can set
`SLEIGHT_CURSOR_TEST=1` and `SLEIGHT_CHARACTERS_DIR` to an absolute, normalized private directory with no symlink in its path.
Renderer tests pass an explicit `root` to the loader functions.

The importer copies a validated snapshot into a private staging directory, validates it again, then publishes it with one
rename. An existing character is never replaced. Remove it before importing a revised version. Import never writes
`hand.json` or selects a character. The next import removes private, user-owned `.import-*` staging folders older than
60 seconds. Fresh staging folders and symlinks are left alone.

## Built-in characters

Built-in packs live at `plugins/sleight/characters/<id>/` inside the plugin. They are read-only built-ins and are never
copied to the user character directory. List and the picker show them first, marked as built-in. Selecting one enables
its sprite style. Installing the plugin leaves the current cursor settings unchanged.

`plugins/sleight/characters/manifest.json` pins every pack file with SHA-256. A failed hash skips the pack in the picker;
list reports the failure and doctor prints a `PROBLEM` line. The native host also pins each built-in sheet's hash before
sending it to the same sandboxed decoder and pixel checks used for imported art. Built-in files accept exactly 0600 and
0644. Temporary Claude Code and Codex plugin installs each produced 338 non-executable data files, all 0644 (2026-10-26).
Imported files still require 0600. Both loaders require absolute canonical built-in paths, with no symlink in the root,
its ancestors or the pack. Hardlinks and writable shared files are refused for both.

The manifest and native sheet pins detect accidental corruption. They do not protect against a process running as the
same user: it can rewrite the manifest and art together, and it can write the open inode between the host's hash check
and decoder read. The native pins cover sheets only, not character names, personality lines or previews. The same-user
write window also exists for the private user bank.

The IDs `tsugi`, `shizu`, `bit`, `kit`, `yori` and `tab` are reserved, including when a bundled file needs repair.
Import refuses those IDs regardless of display name. To make a variant, give it a different manifest ID.
Remove refuses built-ins. An old user folder with a reserved ID cannot shadow the bundled pack, but remains removable
with `sleight-mcp cursor remove <id>`. The picker shows a separate "renamed needed" row that opens the user bank for repair.

The generator is included in the plugin at `skills/make-character/tool/`. The repository entry point is
`tools/characters/build.mjs`. Its cast data, poses and styles draw all six characters in code under MIT.
On macOS with `cwebp` 1.6.0 on PATH, build into a new directory with no symlink ancestors:

```sh
nice -n 20 node tools/characters/build.mjs --out /private/tmp/sleight-cast-build
```

macOS `sips` rasterizes the SVGs without a browser or window. After PNG metadata is stripped, `cwebp` encodes every atlas
with lossless WebP (`-lossless -z 9 -exact`). `sheet.webp` is already allowed by format v1. Each pack includes the main sheet,
extra sheet, perch sheet, preview and personality lines. The committed art is the owner-approved Chromium render,
converted losslessly to WebP. Conversion verifies all RGBA values, including hidden RGB, before publishing. Removing the
sRGB ICC metadata does not change pixel values. A fresh sips build is close to the committed art, not identical: mean RGB
difference 0.26 to 0.64 of 255 per pack and up to 125 on single edge pixels, mostly in eyes and glints. The sips generator uses
luminance masks for hair shine. `tools/characters/proof.mjs` compares every generated frame with approved art and
checks isolated shine against the hair's alpha support on all three sheets.

`tests/character-rebuild.test.mjs` compares manifests, resolved states, sheet dimensions and alpha structure, without
requiring identical image bytes. Its tested toolchain is macOS 27.0.1 and cwebp 1.6.0, recorded in
`tools/characters/toolchain.mjs`. The test skips raster qualification with a reason when cwebp is missing or
the operating system or encoder version is untested. The native pin and packaged hash checks still run on every platform.

After replacing the committed packs and manifest with reviewed output, run
`node tools/characters/build.mjs --sync-native-pins` to update the host's compiled sheet pins. The pin test checks that
these match. Run `node tools/characters/check.mjs` to verify hashes, lossless encoding and the 8,000,000-byte character
budget, including the hash manifest. It also reports the complete plugin's uncompressed size.

## Manifest

This example defines idle and click art. The remaining 17 states use fallbacks.

```json
{
  "format": "sleight-character",
  "version": 1,
  "id": "my-character",
  "name": "My Character",
  "description": "A character I drew.",
  "author": "My name",
  "license": "CC0-1.0",
  "sheet": "sheet.webp",
  "extra": "extra.webp",
  "frame": { "w": 192, "h": 208 },
  "grid": { "cols": 8, "rows": 11 },
  "scale": 1,
  "anchor": { "x": 96, "y": 196 },
  "hotspot": { "x": 96, "y": 104 },
  "states": {
    "idle": { "row": 0, "frames": 6, "ms": [280, 110, 110, 140, 140, 320], "loop": true },
    "click": { "sheet": "extra", "row": 0, "frames": 4, "ms": 100, "loop": false }
  }
}
```

- `format` is `sleight-character`, and `version` is 1. Other versions are refused.
- `id` is 1 to 48 characters matching `[a-z0-9-]`. `name` is 1 to 60 characters, `description` is 0 to 200, and `author`
  is 1 to 80. These fields are required. Text is displayed as plain text. Ordinary punctuation, including `/`, is allowed.
  Terminal controls, bidi controls and invisible direction marks are refused.
- `license` is a required string, 1 to 120 characters. Every source folder with its own `character.json` is a shared pack
  and must state a license. Only a manifest generated from a Codex `pet.json` may use `unknown`, displayed as
  `License: not stated`. A previously imported Codex character with `unknown` still loads locally, but needs a stated license
  before re-importing it as a pack. The validator recognizes CC0, CC-BY family licenses, MIT, Apache-2.0, BSD-2-Clause,
  BSD-3-Clause, ISC, Unlicense, GPL-2.0-only, GPL-2.0-or-later, GPL-3.0-only, GPL-3.0-or-later and OFL-1.1.
  Other identifiers or custom terms need `LICENSE.txt`. `proprietary-personal` is also accepted. Attribution is unverified.
- `sheet` is `sheet.png` or `sheet.webp`. Set `extra` to `extra.png` or `extra.webp` when extra rows are present. File extensions must agree
  with image magic bytes. Paths and URLs are refused.
- `frame` defaults to 192 by 208 pixels. The width must be an integer from 64 to 192 and the height from 64 to 208, so
  every sheet fits the hand host's 1536 by 2288 cap.
- `grid` has 8 columns and a positive integer row count. The main image must be exactly `cols * frame.w` by
  `rows * frame.h`. Only the rows your states need must be present, within the pixel budget.
- `scale` defaults to 1 and must be 0.25 to 2. It multiplies the user's size setting. The artist chooses the frame size within the caps.
- `anchor` and `hotspot` are required `{ "x": number, "y": number }` coordinates in cell pixels, measured from the top left.
  Each coordinate may range from minus one cell to twice the cell size. A state can override `hotspot`. The ring keeps
  marking the point even when a character has no pointing hand.
- `states.idle` must contain timed art. Other states may be absent. Unknown fields and state names produce warnings and
  are ignored by the resolver. All manifest strings, including ignored fields, must be plain text of at most 200 characters;
  keys have an 80-character cap. The specific field caps above still apply.

A timed state has `row`, `frames`, `ms`, and `loop`. Rows and columns start at zero. `frames` is 1 to 8. `ms` is one number
or an array with one duration per frame, each 20 to 2000 milliseconds, with at most 4000 milliseconds in one cycle.
Looping frames must each last at least 40 milliseconds. `loop` is a boolean. Optional `start` selects the first column,
defaulting to zero. `start + frames` must not exceed 8. It lets imported jumps use a slice of an unchanged row.

Optional `sheet: "extra"` selects the extra atlas. Absent or `"sheet"` selects the main atlas. Optional `flip: "h"` mirrors
art horizontally. Mirroring is off by default, including imports. A fallback-only state can set `flip` or `hotspot`:

```json
{
  "running-left": { "fallback": "running-right", "flip": "h" }
}
```

A direction state is `{ "dir16": { "rowA": 9, "rowB": 10 } }`, with optional sheet, hotspot, flip and fallback fields.
Only `move`, `drag-carry` and the helper `look` accept this form. Each row has 8 poses. `rowA` faces 0 through 157.5 degrees.
`rowB` faces 180 through 337.5 degrees. Zero is up and angles go clockwise. The resolver selects the nearest 22.5-degree pose.
A timed state and `dir16` cannot be combined. For a directional aim in an artist's pack, define `look` and use
`"aim": { "fallback": "look" }`. Imported Codex aim uses its metadata to select the matching pose from rows 9 and 10.

## The 19 event states

Only `idle` is mandatory to load a pack. A full set defines art directly for all 19 event states. A fallback-only entry
still counts as missing its own animation. Optional helper animations are `running-right`, `running-left`, `look`, `poke`
and `wave`. They do not increase the count beyond 19.

Fallbacks try the first available animation, following nested chains. An explicit `fallback` replaces a state's default
chain. Explicit fallback names must be from this table or the helper list, and explicit cycles are refused. Default chains
such as type/key and thinking/working skip a visited state and eventually reach idle.

| State | Default fallback chain or behavior | Codex v2 import |
| --- | --- | --- |
| idle | Required timed art | Row 0, 6 frames |
| move | Running right or left by heading, look, idle while travelling | Rows 9/10; rows 1/2 for horizontal travel over 60 px |
| aim | Look, idle | Row 9/10 pose toward target, held 160 ms |
| click | Poke, wave, idle pulse | Row 4, columns 1 to 3 |
| double-click | Click twice, idle | Click twice |
| right-click | Click, idle | Row 3, first 3 wave frames |
| type | Key, working, idle | Row 7, 6 running frames |
| key | First 3 type frames, click, idle | Row 7, first 3 frames |
| scroll-up | Working with look up, idle | Row 7 and row 9 column 0 pose |
| scroll-down | Working with look down, idle | Row 7 and row 10 column 0 pose |
| drag-grab | Click start, hold last frame, idle | Row 4, columns 0 and 1 |
| drag-carry | Move, idle | Move, including directional travel |
| drag-drop | Click, idle | Row 4, columns 3 and 4 |
| waiting-approval | Idle attention pulse | Row 6, 6 waiting frames |
| error | Idle red pulse | Row 5, 8 failed frames, once |
| success | Wave once, idle | Row 3, 4 waving frames, once |
| thinking | Working, idle | Row 8, 6 review frames |
| handoff | Success, then idle | Wave, then idle |
| working | Thinking, idle | Row 7 through the type fallback |

Scroll art is never mirrored vertically. Tint, pulse, hold and follow-up metadata describe fallback behavior for the
renderer. With reduced motion enabled, the renderer uses the first resolved frame for every state, no movement easing,
and a 150 ms fade. Idle's first frame is the still frame.

### Codex and Petdex compatibility

Pass a folder containing `pet.json` and the image named by `spritesheetPath`. The manifest must have
`id`, `displayName` and a local `spritesheetPath`. `description` may be absent. The importer copies the PNG or WebP
byte for byte to `sheet.png` or `sheet.webp` and generates `character.json`.

| `spriteVersionNumber` | Grid | Atlas pixels |
| --- | --- | --- |
| Absent or `1` | 8 columns, 9 rows | 1536 by 1872 |
| `2` | 8 columns, 11 rows | 1536 by 2288 |

Both use 192 by 208 pixel cells. Other versions, scaled atlases and version/dimension mismatches are refused.
[Petdex's package docs](https://github.com/crafter-station/petdex#pet-package-format) describe both layouts.
See [character sharing](character-sharing.md) for importing a local Petdex folder. sleight never fetches a pasted URL.

The row indexes and use of v2's two extra rows below are sleight's existing Codex mapping. Petdex documents the nine
state names and leaves the extra rows to the consuming client, without specifying these indexes or look directions.
Codex rows are: idle 0, running-right 1, running-left 2, waving 3, jumping 4, failed 5, waiting 6, running 7, review 8,
look A 9 and look B 10. Generated anchors are (96,196), and hotspots are (96,104). The generated `codex` object stores
`{ "spriteVersionNumber": 1, "importedFrom": "original-id" }` for 9 rows, or version 2 for 11 rows. Keep it when adding extra art.
Rows 9 and 10 exist only in v2. A 9-row pet uses running-right or running-left for movement at every distance, idle art
for aim, and running art for scroll without a look pose. Its 7 direct event animations leave 12 moves using fallbacks.
The callout lists each missing animation and explains that it has no look directions. The source rows are copied unchanged.

Idle durations are 280, 110, 110, 140, 140, 320 ms. Running rows use 120 ms per frame and 220 on the last frame. Waving uses
140 ms and 280 on the last frame. Failed uses 140 ms and 240 on the last frame. Waiting uses 150 ms and 260 on the last.
Review uses 150 ms and 280 on the last. Jump slices use 140 ms, with 280 ms on the landing frame. The copied atlas's unused
cells and optional neutral look cell remain untouched. The optional neutral cell at row 0, column 6 is not mapped or used.

A v2 import supplies art directly for 9 sleight states. The other 10 use fallbacks. This count comes from the resolved table,
not from a fixed wizard message. The wizard and `check` show one line per missing move, naming the fallback animation and
any added pulse, look pose, repeated frames, hold or return to rest. For a Codex-only pet the callout starts:

```text
This pet has its own animation for 9 of sleight's 19 moves. To animate all of them it needs 10 more:
Double-click: uses its jumping animation, played twice
Right-click: uses its waving animation
Key press: uses its running animation, first 3 frames
```

### Cua cursor themes

[Cua's public cursor-theme docs](https://cua.ai/docs/cua-driver/guides/operate#personalize-the-cursor) describe a dotLottie
archive with `cua/theme.json`, schema `cua.cursor-theme/2`, twelve action animations at 128 by 128 pixels and 30 fps,
a still frame for each, author and license. Its actions include observe, navigate, app, transfer, record and system.

Import would need a Lottie player to turn JSON into raster frames. sleight does not have that player or rasterizer,
so direct import is unsupported. A bounded, dependency-free converter would support only a subset of those animations.

sleight's character format stores static PNG or WebP atlases, frame timings and fallbacks for 19 event states. Its
[cursor protocol](cursor-protocol.md) defines local event records independently of the renderer or character art.
Cua's theme archive packages animations for its own driver. Cua already provides agent cursors with custom themes.

An author can render their own theme to PNG or WebP with an external tool, arrange the cells and write `character.json`.
That local pack must pass the same validator and sandboxed decoder as every other pack. sleight does not open a theme
archive, run its contents, fetch assets or install a player. External conversion and Cua rendering were not tested here.

### Adding extra rows

Keep the original Codex sheet unchanged. Draw an `extra.png` or `extra.webp` with 8 columns, the same cell dimensions and as many complete
rows as needed within the size and pixel limits. Its height determines its row count. Add `"extra": "extra.webp"` at the
top of the manifest, then put `"sheet": "extra"` on each state using it. Rows start at zero within each sheet.

The manifest above adds a four-frame click in extra row 0. Add a timed entry for each missing event to make
it count as having its own animation. Reusing an existing row directly also counts as an explicit animation assignment.

## Perch mode and lines

In perch mode the character is drawn on the target window's top edge (see the ring doc's perch section). A pack can add a
third sheet and ten optional states for it:

```json
{
  "perch": { "anchor": { "x": 96, "y": 150 }, "sheet": "perch.webp" },
  "states": {
    "perch": { "sheet": "perch", "row": 0, "frames": 6, "ms": [320, 120, 120, 260, 260, 400], "loop": true },
    "high-five": { "sheet": "perch", "row": 2, "frames": 3, "ms": [90, 120, 420], "loop": false, "hotspot": { "x": 139, "y": 89 } }
  }
}
```

`perch.anchor` is the seat point in cell pixels: it rests on the window's top edge. It defaults to `anchor`, so a pet
without perch art stands on the edge. `perch.sheet` is `perch.png` or `perch.webp` and follows the extra sheet's rules (8
columns of whole cells, at most 1536 by 2288 pixels and 8 MiB). A state uses it with `"sheet": "perch"`. The states
and their fallbacks:

| State | Without its own art |
| --- | --- |
| perch | idle |
| perch-peek | look at heading 180, masked at the edge; else idle's first cell |
| perch-hop | jumping columns 0, 1, 3 and 4 |
| perch-point-left, perch-point-right | look at heading 225 or 135, then aim, then idle's first cell |
| sleep | idle's first cell (the host draws the z glyphs) |
| high-five | wave, then success. It plays once a turn, and its `hotspot` is where the turn's burst plays |
| perch-wait | waiting-approval |
| startle | error's first 2 frames |
| jumping | the leap's arc. A Codex pet uses row 4 |
| paused | A1's paused pose while the person has paused sleight: waiting-approval once, holding its last cell |

These states do not count toward the 19 moves. `resolvePerchStates(manifest)` returns `{ anchor, states }` with every
perch state plus `jumping`, both runs, `error` and `handoff`, resolved to concrete cells.

An optional `lines` block holds the character's own short sentences, keyed by moment: `start`, `first-click`, `typing`,
`long-wait`, `approval`, `error`, `done`, `handback` and `wake`, plus `lang` (a BCP 47 tag of at most 16 characters).
Each moment has 1 to 16 lines. A line is 1 to 60 characters after trimming, on one line, in plain text. Emoji are
allowed. Control and bidi characters, `<`, `>`, `{`, `}`, backticks, `*`, `_`, `[`, `]`, `|`, URLs and paths (`://`,
`www.`, `/` before a letter, `~/`), and the words `system`, `assistant`, `ignore` and `tool` are refused. The block is
at most 4 KiB. A block that breaks these rules is dropped with one warning, and the pack still loads. Unknown keys warn
and are ignored. Lines are data the host draws. They never reach the model, a tool result or the cursor stream.

## Validation limits

The Node loader checks these on import, installation and every load:

- Valid UTF-8 JSON, fewer than 16,384 bytes, no duplicate keys, nesting at most 32 levels, correct format/version and field
  types. Folder and manifest IDs must match only for installed characters.
- Only the listed files, at most 8 entries, no subdirectories, executable files, links or shared writable files. Installed
  modes must be exactly 0700 for the directory and 0600 for files. File descriptors are checked after opening with no-follow.
- PNG requires IHDR first, at least one IDAT before IEND, bounded chunk lengths and no data after IEND. WebP requires VP8,
  VP8L or VP8X first and exactly one image chunk. A VP8X canvas must equal the image bitstream's dimensions and appear only
  once, first. APNG and animated WebP are refused. A header check does not prove decoding succeeds.
- Main, extra and perch images at most 8 MiB each, preview at most 1 MiB and `LICENSE.txt` at most 64 KiB. Total bytes, including
  JSON and license, at most 16 MiB. Each image side is at most 4096 pixels; all images together are at most 16,000,000 pixels.
- Exact cell grids, valid row and frame ranges, duration limits, scale, coordinates and acyclic explicit fallback names.
- Required license field. A source with `character.json` must state a license. Only the generated Codex-import manifest may
  have `unknown`.

Warnings from the Node loader cover ignored fields or states, missing required event art, coordinates outside the cell
and nonlooping durations below 40 ms.

The native host must decode within the same budgets. It must check for an alpha channel and transparency. Each used cell
needs at least 50 visible pixels and at most 95% opacity, and unused cells must be transparent. Hidden RGB, green chroma fringe and cell-edge
clipping are pixel checks for host warnings. Chroma fringe warns and never refuses an import. Failed decoding must return
to the ring. These host checks belong to the renderer and are not established by `cursor check` in this lane.

## Make one with your agent

1. Ask your agent to draw rows of 192 by 208 transparent cells, 8 columns across. Draw the first idle frame so it also works
   as a still image. Export PNG or WebP.
2. Save the main atlas as `sheet.png` or `sheet.webp`. Write `character.json` with your ID, attribution, license, grid and
   timed idle row. Add event states or an extra PNG or WebP sheet as needed.
3. Run `sleight-mcp cursor import ./my-character`. Read its size, license and missing-animation table before confirming.
   The default answer is No. A non-TTY import requires `--yes`.
4. Run `sleight-mcp cursor check my-character` to validate the installed copy and print that table again.
   `sleight-mcp cursor list` lists installed characters. `sleight-mcp cursor remove my-character` removes one.

List reports stray entries as skipped and keeps listing healthy characters when one needs repair. A broken character
appears as `needs repair: <reason>` and makes list exit 1. Remove checks the root and directory owner before deleting
a character. Broken manifests can be removed, but symlinks are refused. A named stray file is skipped.

Import and remove are user commands. Claude's shell guard refuses them through the same hook that protects `hand on|off`.
Claude can call list and check. This guard covers ordinary shell spellings, including nested shells. It does not sandbox
arbitrary scripts a model writes and runs.

Importing leaves the sprite hidden. Turn it on with `sleight-mcp cursor style sprite <id>`. A Codex import draws at
scale 0.5, so its 192x208 cells show as 96x104 pt. Cells are at most 192x208 and sheets at most 1536x2288, the hand
host's caps.

## Loader interface for renderers

`plugins/sleight/lib/hand/character.mjs` exports `loadCharacter(folder)` and `checkCharacter(id)` for validated loads.
Results contain the normalized `manifest`, header-only `sheets`, `files` as a map of snapshot buffers, total byte count,
`warnings`, a 19-entry `resolved` table and the `perch` table from `resolvePerchStates`. Installed loads use `installed: true` to enforce private file modes.
`checkCharacter(id)` resolves built-ins through their hash manifest. Built-in results have `builtin: true`.
`listCharacters()` returns built-ins first, then user packs. It also returns `{ id, skipped, reason }` for stray entries and `{ id, error }` for broken characters.

`resolveCharacterStates(manifest, { heading, distance })` resolves a validated manifest for one heading in degrees and a
travel distance in pixels. Each entry has `state`, `label`, `own`, `source`, `shows`, concrete `sheet` filename, `row`,
`start`, `frames`, an `ms` array, `loop`, `flip` (false or `h`) and `hotspot`. Fallback metadata includes `repeat`, `holdLast`,
`then`, `look` and `effect`. `characterCallout(result)` formats the same resolved table used by the wizard.

Call `loadCharacter` again before a later load from disk. A previous result proves only that captured snapshot. A renderer
must perform the native pixel checks before drawing it. No character file is evaluated or imported as code.
The Node path checks and descriptor rechecks do not exclude every directory-swap race by a process with the same user ID.
Node has no directory-relative `openat` API. Snapshot buffers remain fixed once read and are revalidated before installation.

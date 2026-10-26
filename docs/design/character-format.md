# sleight character format v1

A character is a local folder of images and a `character.json` manifest. sleight does not include characters, pets or vendor art.
The default cursor is sleight's ring. Importing a character leaves its sprite hidden. In overlay mode the sprite trails
that ring, which always marks the exact point. The sprite's anchor controls its offset. Rendering and style selection
are separate from importing.

The format belongs to sleight's open cursor protocol. Codex v2 pets import without changing their atlas bytes.
Character data remains on this Mac. Names and descriptions appear in the user CLI and picker, never in model prompts or tool results.

## Files

```text
my-character/
  character.json
  sheet.png          # or sheet.webp
  extra.webp         # optional extra rows
  preview.png        # optional, at most 256 by 256 pixels
  LICENSE.txt        # terms for a license the validator does not recognize
```

The folder name must equal the manifest's `id`. No other files or subfolders are allowed. This CLI accepts folders.
Archive extraction is outside this version of the importer. Do not put a `pet.json` beside `character.json`.

Characters install under `~/Library/Application Support/sleight/characters/<id>/`. Directories have mode 0700 and files
have mode 0600, owned by the current user. Sources must be user-owned, have no executable files and have no group or world
write permission. Symlinks, including a symlink in the path, and hardlinked files are refused. Tests can set
`SLEIGHT_CHARACTERS_DIR` to an absolute, normalized private directory with no symlink in its path.

The importer copies a validated snapshot into a private staging directory, validates it again, then publishes it with one
rename. An existing character is never replaced. Remove it before importing a revised version. Import never writes
`hand.json` or selects a character.

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
  is 1 to 80. These fields are required. Text is plain, with no markup, path separators, terminal controls or bidi controls.
- `license` is a required string, 1 to 120 characters. Local imports may use `unknown`, displayed as `License: not stated`.
  A shared pack must state a license. The validator recognizes CC0, CC-BY family licenses, MIT, Apache-2.0, BSD-2-Clause,
  BSD-3-Clause, ISC, Unlicense, GPL-2.0-only, GPL-2.0-or-later, GPL-3.0-only, GPL-3.0-or-later and OFL-1.1.
  Other identifiers or custom terms need `LICENSE.txt`. `proprietary-personal` is also accepted. Attribution is unverified.
- `sheet` is `sheet.png` or `sheet.webp`. Set `extra` to `extra.webp` when extra rows are present. File extensions must agree
  with image magic bytes. Paths and URLs are refused.
- `frame` defaults to 192 by 208 pixels. Each side must be an integer from 64 to 512.
- `grid` has 8 columns and a positive integer row count. The main image must be exactly `cols * frame.w` by
  `rows * frame.h`. Only the rows your states need must be present, within the pixel budget.
- `scale` defaults to 1 and must be 0.25 to 2. It multiplies the user's size setting. Frame sizes larger than 192 can supply
  denser art. The artist chooses the frame size.
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
| right-click | Click with ring tint, idle | Row 3, first 3 wave frames |
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

### Codex v2 compatibility

Pass a folder containing `pet.json` and the image named by `spritesheetPath`. The manifest must have
`spriteVersionNumber: 2`, `id`, and `displayName`. `description` may be absent. The importer copies the PNG or WebP
byte for byte to `sheet.png` or `sheet.webp` and generates `character.json`. The image must measure 1536 by 2288 pixels. Its grid has 8 columns and 11 rows of 192 by 208 cells. Codex v1 atlases are refused.

Codex rows are: idle 0, running-right 1, running-left 2, waving 3, jumping 4, failed 5, waiting 6, running 7, review 8,
look A 9 and look B 10. Generated anchors are (96,196), and hotspots are (96,104). The generated `codex` object stores
`{ "spriteVersionNumber": 2, "importedFrom": "original-id" }`. Keep it when adding extra art.

Idle durations are 280, 110, 110, 140, 140, 320 ms. Running rows use 120 ms per frame and 220 on the last frame. Waving uses
140 ms and 280 on the last frame. Failed uses 140 ms and 240 on the last frame. Waiting uses 150 ms and 260 on the last.
Review uses 150 ms and 280 on the last. Jump slices use 140 ms, with 280 ms on the landing frame. The copied atlas's unused
cells and optional neutral look cell remain untouched.

A Codex import supplies art directly for 9 sleight states. The other 10 use fallbacks. This count comes from the resolved table,
not from a fixed wizard message. The wizard and `check` show one line per missing state describing its replacement.

### Adding extra rows

Keep the original Codex sheet unchanged. Draw an `extra.webp` with 8 columns, the same cell dimensions and as many complete
rows as needed within the size and pixel limits. Its height determines its row count. Add `"extra": "extra.webp"` at the
top of the manifest, then put `"sheet": "extra"` on each state using it. Rows start at zero within each sheet.

The manifest above adds a four-frame click in extra row 0. Add a timed entry for each missing event to make
it count as having its own animation. Reusing an existing row directly also counts as an explicit animation assignment.

## Validation limits

The Node loader checks these on import, installation and every load:

- Valid UTF-8 JSON, fewer than 16,384 bytes, no duplicate keys, nesting at most 32 levels, correct format/version and field
  types. The folder and manifest IDs must match.
- Only the listed files, at most 8 entries, no subdirectories, executable files, links or shared writable files. Installed
  modes must be exactly 0700 for the directory and 0600 for files. File descriptors are checked after opening with no-follow.
- PNG and WebP magic and header dimensions, with APNG and animated WebP refused. A header check does not prove decoding succeeds.
- Main and extra images at most 8 MiB each, preview at most 1 MiB and `LICENSE.txt` at most 64 KiB. Total bytes, including
  JSON and license, at most 16 MiB. Each image side is at most 4096 pixels; all images together are at most 16,000,000 pixels.
- Exact cell grids, valid row and frame ranges, duration limits, scale, coordinates and acyclic explicit fallback names.
- Required license field. `unknown` is allowed locally, and is refused when validating a pack for sharing.

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
   timed idle row. Add event states or an `extra.webp` as needed.
3. Run `sleight-mcp cursor import ./my-character`. Read its size, license and missing-animation table before confirming.
   The default answer is No. A non-TTY import requires `--yes`.
4. Run `sleight-mcp cursor check my-character` to validate the installed copy and print that table again.
   `sleight-mcp cursor list` lists installed characters. `sleight-mcp cursor remove my-character` removes one.

Importing leaves the sprite hidden. Turn it on with `sleight-mcp cursor style sprite` when style selection is available.
The style command currently prints `coming in 1.5.1`.

## Loader interface for renderers

`plugins/sleight/lib/hand/character.mjs` exports `loadCharacter(folder)` and `checkCharacter(id)` for validated loads.
Results contain the normalized `manifest`, header-only `sheets`, `files` as a map of snapshot buffers, total byte count,
`warnings` and a 19-entry `resolved` table. Installed loads use `installed: true` to enforce private file modes.

`resolveCharacterStates(manifest, { heading, distance })` resolves a validated manifest for one heading in degrees and a
travel distance in pixels. Each entry has `state`, `label`, `own`, `source`, `shows`, concrete `sheet` filename, `row`,
`start`, `frames`, an `ms` array, `loop`, `flip` (false or `h`) and `hotspot`. Fallback metadata includes `repeat`, `holdLast`,
`then`, `look` and `effect`. `characterCallout(result)` formats the same resolved table used by the wizard.

Call `loadCharacter` again before a later load from disk. A previous result proves only that captured snapshot. A renderer
must perform the native pixel checks before drawing it. No character file is evaluated or imported as code.

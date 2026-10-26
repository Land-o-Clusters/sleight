---
name: make-character
disable-model-invocation: true
description: Use to make a sleight cursor character.
---

# Make a sleight character

A character is a folder of art with `character.json`, `sheet.webp`, `extra.webp`, `perch.webp` and `preview.png`. It trails
sleight's ring, which always marks the exact point. sleight keeps its names and images out of the model's prompts.

Draw everything in code. Never trace, sample or generate the art with an image model, and never draw a real person,
a company's mascot or logo, or an existing character. Keep it a work buddy: age-neutral or clearly adult, modest
clothes, no romance, flirting, pleading, hearts or blown kisses.

## Steps

1. Use a sleight source checkout matching the installed release. If none is available, download that release's
   source from https://github.com/Land-o-Clusters/sleight. Use its `tools/characters/` generator in place.
   Create `character/` in the person's project for their own design and output. The generator needs macOS
   (`sips`), Node 22+ and `cwebp` 1.6.0.
2. Ask what they want in one question: a style (`anime`, `pixel` or `paper`), a name, two or three colors and one
   personality line. Copy the closest design from the checkout's `tools/characters/cast/` to `character/<id>.mjs` (`tsugi` or `yori` for anime
   people, `kit` for an anime creature, `bit` for pixel, `tab` for paper). The id is 1 to 48 of `a-z 0-9 -`.
3. Change the data before any code: `id`, `name`, `description`, `author`, `license` (MIT or CC0-1.0 for their own
   art), palettes (`base`, `shade`, `light`, `line`), hair and outfit styles, `build` (proportions), `E` (motion:
   1 bouncy, 0.6 calm) and `expr` (expression swaps such as `{ grin: 'smile2' }`).
4. Render with the checkout's `node tools/characters/build.mjs --design /path/to/character/<id>.mjs --out /path/to/character/output`.
   The output directory must be new. Read `output/<id>/preview.png` and the three WebP sheets at 96 by 104 pt
   per cell, on light and dark backgrounds. Fix what reads badly at the small size and render into a new output
   directory. Repeat until the face, silhouette and every state read.
5. For a part the styles lack (a hat, a tail, a prop), edit the checkout's builder in `tools/characters/styles/<style>.mjs`. To change a motion for
   every state, edit its clip in `tools/characters/lib/poses.mjs`. Keep cycles at or under 4000 ms and loop frames at 40 ms or more.
6. The run must print `19/19 states` and exit 0. Then tell the person to run these in their own terminal, because Claude's shell is
   refused for both by design (only `cursor list`, `check` and `status` run there):

   ```sh
   sleight-mcp cursor import ./character/output/<id>
   sleight-mcp cursor style sprite <id>
   ```

   Import shows the size, license and missing-animation table and asks to confirm. Don't run it, and don't use
   `--yes` on their behalf.
7. After they import, run `sleight-mcp cursor check <id>` and report its table. A character with all 19 moves says so.

## Color and line rules

- Flat base, one hard shade (the part minus a copy shifted toward the upper-left light), and one highlight on named
  shapes only, with no gradients.
- Inner lines 1.1 to 1.4 px in each part's dark color. The outline adds a 1.5 px ink rim, plus a 2.2 px soft light
  rim so dark parts show on dark windows.
- Warm `#ff7a3d` on the viewer's left and cool `#5b8dff` on the right match the ring. Every effect uses `tools/characters/lib/fx.mjs`.
- Eyes at least 12 px tall in the 192 by 208 cell. Face in the upper half. Nothing on a cell edge.

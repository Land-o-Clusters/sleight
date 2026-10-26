---
name: make-character
disable-model-invocation: true
description: Use to make a sleight cursor character.
---

# Make a sleight character

A character is a folder of art with `character.json`, `sheet.png` or WebP, extra and perch sheets and `preview.png`. It trails
sleight's ring, which always marks the exact point. sleight keeps its names and images out of the model's prompts.

Draw everything in code. Never trace, sample or generate the art with an image model, and never draw a real person,
a company's mascot or logo, or an existing character. Keep it a work buddy: age-neutral or clearly adult, modest
clothes, no romance, flirting, pleading, hearts or blown kisses.

## Steps

1. Use `tool/` beside this installed skill file. Call its absolute path TOOL in the commands below.
   Create `character/` in the person's project for their design and output. The generator needs macOS `sips`
   and Node 22+. Tested with `cwebp` 1.6.0. Other versions fall back to PNG. A missing encoder or failed encode also uses PNG.
   Both are character format v1. You don't need a source checkout or package install.
2. Ask what they want in one question: a style (`anime`, `pixel` or `paper`), a name, two or three colors and one
   personality line. Copy the closest design from `TOOL/cast/` to `character/<id>.mjs` (`tsugi` or `yori` for anime
   people, `kit` for an anime creature, `bit` for pixel, `tab` for paper). The id is 1 to 48 of `a-z 0-9 -`.
3. Change the data before any code: `id`, `name`, `description`, `author`, `license` (MIT or CC0-1.0 for their own
   art), palettes (`base`, `shade`, `light`, `line`), hair and outfit styles, `build` (proportions), `E` (motion:
   1 bouncy, 0.6 calm) and `expr` (expression swaps such as `{ grin: 'smile2' }`).
4. Render with `node TOOL/build.mjs --design /path/to/character/<id>.mjs --out /path/to/character/output`.
   The output directory must be new and have no symlink ancestors. Use `/private/tmp` instead of `/tmp` on macOS.
   Read `output/<id>/preview.png` and all six contact sheets in
   `output/review/<id>/`: `sheet-light.png`, `sheet-dark.png`, `extra-light.png`, `extra-dark.png`,
   `perch-light.png` and `perch-dark.png`. Each cell is 96 by 104 pixels, the default display size.
   Review at 100% on both backgrounds. Fix the face, silhouette and any unclear state, then render into a new output directory.
5. For a part the styles lack (a hat, a tail, a prop), copy only `tool/` and the plugin's
   `lib/hand/character.mjs` into `character/generator/`, preserving these relative paths:
   `skills/make-character/tool/` and `lib/hand/character.mjs`. Point TOOL to that copy's `skills/make-character/tool/`.
   Edit `TOOL/styles/<style>.mjs` for parts or `TOOL/lib/poses.mjs` for motions. Leave the installed plugin unchanged.
   Keep cycles at or under 4000 ms and loop frames at 40 ms or more.
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
- Warm `#ff7a3d` on the viewer's left and cool `#5b8dff` on the right match the ring. Every effect uses `TOOL/lib/fx.mjs`.
- Eyes at least 12 px tall in the 192 by 208 cell. Face in the upper half. Nothing on a cell edge.

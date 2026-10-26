# Character sharing and Petdex imports

Import a pet folder already downloaded to this Mac. It needs `pet.json` and the PNG or WebP named by its local
`spritesheetPath`, with `id`, `displayName` and an optional description in the manifest.

```sh
sleight-mcp cursor import "$HOME/.petdex/pets/my-pet"
```

Read the license, size and missing-animation table before confirming. The default answer is No. Import copies the atlas
unchanged, generates `character.json` and leaves the source alone. It does not select a character or display a sprite.
To show it later, choose `sleight-mcp cursor style sprite my-pet`.

[Petdex's README](https://github.com/crafter-station/petdex#for-builders) describes 8 by 9 and v2 8 by 11 atlases with
192 by 208 pixel cells. sleight accepts both at their original sizes: 1536 by 1872 or 1536 by 2288. A missing version or
`spriteVersionNumber: 1` selects 9 rows. Version 2 selects 11. Other versions, scaled atlases and mismatched dimensions
are refused. The first nine rows map to idle, running-right, running-left, waving, jumping, failed, waiting, running and
review. The two v2 rows supply 16 look directions. The [format spec](character-format.md) gives the event mappings.

The 9-row layout draws 7 of sleight's 19 event animations directly, leaving 12 using fallbacks. Movement plays the left or
right running row. Aiming uses idle art while scrolling uses running art without a direction pose. The 11-row layout supplies
9 direct animations and 10 fallbacks. The import wizard lists every missing move and what it shows now. Add your own
`extra.webp` and event mappings for more animations without editing the original sheet.

## Pasted links

URL import is refused, including a Petdex gallery page, `petdex://` link and direct image URL. sleight never fetches
characters or follows redirects. Download direct files yourself, place the image and its matching `pet.json` in a
local folder, then import that folder. A gallery page or manifest endpoint is not a character file. A bare image
also needs the matching local manifest, and ZIP downloads must be extracted to a folder before import.

## Validation and rights

Petdex imports pass the same file ownership, mode, link, JSON, image-header, byte and pixel limits as other local packs.
Installation revalidates a private snapshot. Rendering and `cursor check` use the existing native host's sandboxed
decode child and pixel checks. Importing never starts a renderer.

Petdex's code license does not license its pets: [asset rights belong to their submitters](https://github.com/crafter-station/petdex#license).
The displayed author and license are unverified. A local pet with no license shows "not stated". Obtain permission
before redistributing it and state the license in a shared sleight pack. sleight imports local files and does not upload
them or submit them to Petdex. PX1 does not bundle downloaded pets or vendor art.

## Public references read for PX1

Read on 2026-10-26 at Petdex commit `31c0aee7f4fb387774b87d40e8047dc0f9cea94b`:

- [README](https://github.com/crafter-station/petdex/blob/31c0aee7f4fb387774b87d40e8047dc0f9cea94b/README.md)
- [CLI README](https://github.com/crafter-station/petdex/blob/31c0aee7f4fb387774b87d40e8047dc0f9cea94b/packages/petdex-cli/README.md)
- [MIT license](https://github.com/crafter-station/petdex/blob/31c0aee7f4fb387774b87d40e8047dc0f9cea94b/LICENSE)
- [Public skill](https://github.com/crafter-station/petdex/blob/31c0aee7f4fb387774b87d40e8047dc0f9cea94b/.claude/skills/petdex/SKILL.md)
- [Integration notes](https://github.com/crafter-station/petdex/blob/31c0aee7f4fb387774b87d40e8047dc0f9cea94b/docs/chatgpt-pet-integration.md)
- [MIT manifest source](https://github.com/crafter-station/petdex/blob/31c0aee7f4fb387774b87d40e8047dc0f9cea94b/packages/petdex-cli/src/manifest.ts)
- Version and install excerpts of the [MIT CLI source](https://github.com/crafter-station/petdex/blob/31c0aee7f4fb387774b87d40e8047dc0f9cea94b/packages/petdex-cli/bin/petdex.ts)

These confirmed the layouts, omitted-version rule and local folders. PX1 adds compatibility without reusing code
or artwork. Fixtures draw synthetic squares locally. Research did not download any pets. Cua's public docs and the
conversion decision are linked in the format spec.

# Third-party notices

## Meriyah 7.0.0

Copyright (c) 2019 and later, KFlash and others. Licensed under the ISC License.
The unmodified npm registry distribution supplies these files in `vendor/meriyah/`:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `dist/meriyah.min.mjs` | 133,545 | `d29a5ff8e5fbdb8cb0617a721891fb1d3fb107883dc6f4ee9bda5b32896edf50` |
| `LICENSE.md` | 760 | `e9a5df5a6ae5cd51ca430715f4c62fb5424946e8da07b7caa058a1ba0582a848` |

Total: 134,305 bytes. The [full license](vendor/meriyah/LICENSE.md) is retained.
The registry tarball integrity is
`sha512-eM23BVAsVhOxLEKckm3DopvcEze2o1leYO11xIkYqeeJgaNbzfGS00y7BUp/KeQPcTzXx0cGJRD2V7BYEZnDcg==`.
No files from the ChatGPT app are included.

## Playwright core 1.64.0

Copyright (c) Microsoft Corporation. Licensed under Apache License 2.0.

The runtime at `vendor/playwright-core/` comes from the owner's accepted 1.64.0 FowlBrowser cache distribution.
The `lib/vite`, `types`, `lib/webp_codec.wasm`, `lib/tools` and `bin` groups are omitted.
The remaining 25 files total 6,926,344 bytes.
`lib/direct-browser/inspectors/playwright-files.json` records the SHA-256 of every retained file.
The manifest SHA-256 is `007e376d16f021289548f7b8b622d3cfd8923842605eb6213ae5f2299326131c`.
`lib/coreBundle.js` has SHA-256 `2325ca4c1c83070e89dc49fb82525508f0a68e0cf12e2a624277968da216b7e0`.

The package's full [LICENSE](vendor/playwright-core/LICENSE) and [NOTICE](vendor/playwright-core/NOTICE)
are retained. Its upstream NOTICE states:

> Playwright
> Copyright (c) Microsoft Corporation
>
> This software contains code derived from the Puppeteer project (https://github.com/puppeteer/puppeteer),
> available under the Apache 2.0 license (https://github.com/puppeteer/puppeteer/blob/master/LICENSE).

Retained upstream files are unchanged. LICENSE, NOTICE and ThirdPartyNotices.txt remain in the distribution.
The sleight loader in `lib/direct-browser/worlds.mjs` verifies the inventory before loading the runtime for a trusted turbo caller.

## Original shared modules

The original sleight user-file modules and the action layer retain their design references to
FowlBrowser 8b689249ba4e33d2626487aad930605c62e2c6a7 (MIT) and
Playwright e8149b8257d32dcf8f72573ecc43e72439da7080 (Apache-2.0).
These modules contain independently authored sleight code. The 1.64.0 distribution pin is separate from the source-study revision.

## Turbo v3 background popups and closed roots

The CR1 popup and closed-root implementations are original sleight code (owner, 2026-10-15). No FowlBrowser code is included.


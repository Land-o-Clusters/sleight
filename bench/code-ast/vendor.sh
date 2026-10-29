#!/bin/bash
# Run after the lane gate opens. Only the npm registry supplies vendor bytes.
set -euo pipefail
cd "$(dirname "$0")/../.."
gate="$HOME/Projects/sleight-wt/ledger/vc/night/lanes-may-test"
while [ ! -e "$gate" ] || [ -e /tmp/sleight-hold ]; do sleep 30; done
stage=$(mktemp -d /private/tmp/ca1-meriyah-pack.XXXXXX)
trap 'rm -rf "$stage"' EXIT
curl -fsSL https://registry.npmjs.org/meriyah/7.0.0 -o "$stage/registry.json"
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 npm pack meriyah@7.0.0 --ignore-scripts --pack-destination "$stage"
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node --input-type=module - "$stage" <<'JS'
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const dir = process.argv[2], meta=JSON.parse(readFileSync(join(dir, 'registry.json')));
const integrity='sha512-'+createHash('sha512').update(readFileSync(join(dir,'meriyah-7.0.0.tgz'))).digest('base64');
if(integrity!==meta.dist.integrity) throw new Error('registry integrity mismatch');
console.log(JSON.stringify({version:meta.version,integrity}));
JS
tar -xzf "$stage/meriyah-7.0.0.tgz" -C "$stage"
for file in dist/meriyah.min.mjs LICENSE.md; do
  cmp "$stage/package/$file" "plugins/sleight/vendor/meriyah/$file"
done

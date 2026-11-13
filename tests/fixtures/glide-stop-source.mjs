import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Find the role by its markers so a driver file rename needs no test rename.
export function glideStopSource(directory = fileURLToPath(new URL('../../plugins/sleight/lib/direct-browser/native/', import.meta.url))) {
  const matches = readdirSync(directory).filter(name => name.endsWith('.swift')).map(name => ({
    name, source: readFileSync(join(directory, name), 'utf8'),
  })).filter(({ source }) => source.includes('// BEGIN GLIDE STOP\n'));
  if (matches.length !== 1) throw Error(`Expected exactly one Glide Stop control source in ${directory}; found ${matches.length}`);
  const { source } = matches[0];
  for (const role of ['GLIDE STOP', 'PERSON INPUT']) {
    if (!source.includes(`// END ${role}`) || !source.includes(`// BEGIN ${role}\n`))
      throw Error(`Glide Stop source is missing ${role} markers: ${matches[0].name}`);
  }
  return source;
}

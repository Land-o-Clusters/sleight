import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function validationDataDir(data, env = process.env) {
  const value = data ?? env.SLEIGHT_VALIDATION_DATA ?? join(homedir(), 'Projects/sleight-wt/race-1017/validation-140');
  return resolve(value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value);
}

export function readValidationData(name, data) {
  return JSON.parse(readFileSync(join(validationDataDir(data), name), 'utf8'));
}

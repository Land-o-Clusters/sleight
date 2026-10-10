import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export async function notification(title, message) {
  await promisify(execFile)('/usr/bin/osascript', ['-e',
    `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`], { timeout: 5000 });
}

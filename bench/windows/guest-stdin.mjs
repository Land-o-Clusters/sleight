// PowerShell 5.1 stdin source needs a final blank line. The marker is the last
// successful statement of each wrapper, after the operation's output.
export function guestCommandOutput(stdout) {
  const lines = String(stdout ?? '').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (lines.pop() !== 'SLEIGHT_GUEST_OK') throw Object.assign(Error('GUEST_COMMAND_NOT_RUN'), { code: 'GUEST_COMMAND_NOT_RUN' });
  return lines.join('\n').trim();
}

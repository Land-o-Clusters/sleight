// A timeout reports uncertainty. It never certifies that a launch or input stopped.
export async function bounded(operation, label, timeoutMs = 20000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`Cursor ${label} timeout; keychain or app may be blocked`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

// Compare the rendering fields implemented by both hosts. The complete Swift
// capture keeps Mac pause-control diagnostics; Windows has no pause panel or
// narration bubble. Nonempty narration must never pass as a supported plan.
export function windowsSharedPlans(records) {
  return records.map(record => {
    if (record?.effect !== 'draw') return record;
    const { bubble, pauseControl, ...shared } = record;
    if (bubble !== undefined && bubble !== null) throw Error('Windows narration plan is unsupported');
    if (pauseControl !== undefined) {
      if (!pauseControl || Object.keys(pauseControl).sort().join() !== 'after,rect,sprite' ||
          typeof pauseControl.sprite !== 'boolean' || !Number.isFinite(pauseControl.after) || pauseControl.after < 0 ||
          pauseControl.rect !== null && (!Array.isArray(pauseControl.rect) || pauseControl.rect.length !== 4 ||
            !pauseControl.rect.every(Number.isFinite))) throw Error('Invalid Mac pause-control diagnostic');
    }
    return shared;
  });
}

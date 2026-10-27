// Instrument the pinned fixture in memory, for every arm. No visible markup,
// validation, submit payload, timer or awaited work changes.
export function settingsDialogLog(html, key) {
  const replace = (from, to) => {
    if (html.split(from).length !== 2) throw Error('settings fixture handler changed');
    html = html.replace(from, to);
  };
  replace("$('#form').addEventListener('submit', (ev) => {", `
// Keep the write capability and native beacon in this module's closure. A DOM
// dump and a fetch of the source cannot recover this document's capability.
const gateBeacon = navigator.sendBeacon?.bind(navigator);
const gateStringify = JSON.stringify;
const gateKey = ${JSON.stringify(key)};
let gateOpen = false, gateSequence = 0;
document.querySelector('script[type="module"]')?.remove();
const gateDialog = event => {
  if (event === 'opened' ? gateOpen : !gateOpen) return;
  gateOpen = event === 'opened';
  try {
    if (gateKey && gateBeacon) gateBeacon('/gate-log/settings-dialog', gateStringify({ key: gateKey, sequence: ++gateSequence, event, data: values() }));
  } catch {} // Preserve fixture behavior on a transport failure; missing evidence fails grading.
};
$('#confirm').addEventListener('cancel', () => gateDialog('cancelled'));
$('#confirm').addEventListener('close', () => { if (!$('#confirm').open) gateDialog('cancelled'); });
addEventListener('pagehide', () => gateDialog('cancelled'));
$('#form').addEventListener('submit', (ev) => {`);
  replace("if (showErrors(e)) $('#confirm').showModal();", "if (showErrors(e)) { $('#confirm').showModal(); gateDialog('opened'); }");
  replace("$('#cancel').onclick = () => $('#confirm').close();", "$('#cancel').onclick = () => { gateDialog('cancelled'); $('#confirm').close(); };");
  replace("const v = values(); $('#confirm').close(); await submit('settings', v);", "const v = values(); gateDialog('confirmed'); $('#confirm').close(); await submit('settings', v);");
  return html;
}

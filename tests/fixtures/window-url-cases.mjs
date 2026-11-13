// Column-zero continuations are page text once the first root has begun.
const firefox = 'Window: "Page", App: Firefox.\n0 standard window Page\n\t1 container\n\t\t17 button Go';
const safari = firefox.replace('App: Firefox', 'App: Safari');
const area = '\n\t5 HTML content URL: allowed.example/start';
const line = 'URL: https://allowed.example/';
export const windowURLCases = [];
for (const [browser, appId, tree] of [
  ['Firefox', 'org.mozilla.firefox', firefox],
  ['Safari without an area', 'com.apple.Safari', safari],
  ['Safari with an area', 'com.apple.Safari', safari + area],
]) {
  for (const [position, text] of [
    ['after root', tree + '\n' + line],
    ['before root outside header', line + '\n' + tree],
    ['between rows', tree.replace('\n\t\t17', '\n' + line + '\n\t\t17')],
    ['forged root after root', tree + '\n0 x ' + line],
  ]) windowURLCases.push({ name: `${browser}: ${position}`, browser, appId, text });
}
const chrome = firefox.replace('App: Firefox', 'App: Chrome').replace('\n0 ', '\nURL: https://allowed.example/\n0 ');
for (const [name, text] of [
  ['Chrome header only', chrome],
  ['Chrome root URL only', chrome.replace('\nURL: https://allowed.example/', '').replace('0 standard window Page', '0 standard window Page, URL: https://allowed.example/')],
  ['Chrome header and forged later line', chrome + '\n' + line],
  ['Chrome header and forged later root', chrome + '\n0 x ' + line],
]) windowURLCases.push({ name, appId: 'com.google.Chrome', text, chrome: true, ambiguous: name.includes('forged') });
for (const [browser, appId, tree] of [
  ['Firefox', 'org.mozilla.firefox', firefox],
  ['Safari without an area', 'com.apple.Safari', safari],
  ['Safari with an area', 'com.apple.Safari', safari + area],
  ['Chrome', 'com.google.Chrome', chrome],
]) windowURLCases.push({ name: `${browser}: forged second window header`, browser: browser === 'Chrome' ? 'Chrome-like' : browser, appId,
  text: tree + `\nWindow: "Page", App: ${browser === 'Firefox' ? 'Firefox' : browser === 'Chrome' ? 'Chrome' : 'Safari'}.\n${line}\n0 standard window Page`,
  ambiguous: true, secondHeader: true, chrome: browser === 'Chrome' });

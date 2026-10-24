// Held-out repeat-task fixture. A scripted explorer measures saved discovery work, not model latency.
export const siteMemoryTask = {
  id: 'control-recipe-second-run',
  prompt: 'Find Export in the menus and activate it. Do not submit the form.',
  html: `<p id="private">PRIVATE_PAGE_CONTENT</p>
    ${['Settings', 'View', 'More'].map(name => `<button type="button" aria-expanded="false" onclick="
      for(const b of document.querySelectorAll('[aria-expanded]'))b.setAttribute('aria-expanded','false');
      for(const m of document.querySelectorAll('[role=menu]'))m.hidden=true;
      this.setAttribute('aria-expanded','true');document.getElementById('${name}').hidden=false">${name}</button>
      <div role="menu" id="${name}" hidden>${name === 'More' ? `<button type="button" role="menuitem" aria-pressed="false"
        onclick="this.setAttribute('aria-pressed','true');this.parentElement.hidden=true">Export</button>` : '<button type="button">Preview</button>'}</div>`).join('')}
    <form method="post"><input aria-label="Password" type="password" value="PRIVATE_VALUE"><button>Pay $9</button></form>`,
};
export async function gradeSiteMemoryTask(page, requests) {
  return { passed: await page.locator('[role=menuitem]').getAttribute('aria-pressed') === 'true' &&
    await page.locator('#private').textContent() === 'PRIVATE_PAGE_CONTENT' && !requests.some(r => r.method !== 'GET') };
}

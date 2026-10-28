// Role dispatch and per-field reporting adapt FowlBrowser's MIT fill_form tool
// (mcp/src/tools.mjs:1250-1285). Actions use the engine's documented locator API.
export async function fillForm(tab, fields) {
  if (!tab?.playwright || !Array.isArray(fields)) throw new Error('fillForm needs a browser tab and a field array.');
  const options = { timeoutMs: 1000 }, notes = [];
  const unverifiable = (clicked = false) => Object.assign(new Error((clicked ? 'One click was sent. ' : '') +
    "Read the control's state from a screenshot of it. Click once only if it shows the other state. Never click again to verify."), { unverifiable: true });
  let filled = 0, tree;
  const attribute = value => '"' + value.replace(/["\\\x00-\x1f]/g, char => '\\' + char.charCodeAt(0).toString(16) + ' ') + '"';
  // Resolve numeric references before input. Later actions use the resulting ID or exact label,
  // so adding a validation message does not turn the next index into another control.
  if (fields.some(field => Number.isInteger(field?.index))) {
    try { tree = await tab.getAXState({ disableDiffing: true, emit: false }); }
    catch (error) { tree = ''; notes.push('Index read failed: ' + error.message); }
  }
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i], name = field?.label ?? field?.index ?? (typeof field?.locator === 'string' ? field.locator : i + 1);
    let fallback;
    try {
      if (!field || ['label', 'index', 'locator'].filter(key => field[key] !== undefined).length !== 1) {
        throw new Error('give exactly one label, index or locator');
      }
      const many = Array.isArray(field.value);
      if (many ? ![...field.value].every(value => typeof value === 'string') :
          !['string', 'number', 'boolean'].includes(typeof field.value) ||
          (typeof field.value === 'number' && !Number.isFinite(field.value))) throw new Error('value must be text, a finite number, a boolean or an array of text');
      let loc;
      if (field.index !== undefined) {
        if (!Number.isInteger(field.index) || field.index < 0) throw new Error('index must be a nonnegative integer');
        const line = tree?.split('\n').find(line => new RegExp('^\\t*' + field.index + ' ').test(line));
        if (!line) throw new Error('index is missing from the current tree');
        const id = /\bID: (.*?)(?=, (?:Value|Help|Description):|$)/.exec(line)?.[1];
        const label = /\bDescription: (.*?)(?=, (?:Value|Help|ID):|$)/.exec(line)?.[1];
        if (id) loc = tab.playwright.locator('[id=' + attribute(id) + ']');
        else if (label) loc = tab.playwright.getByLabel(label, { exact: true });
        else throw new Error('index has no stable ID or label; use a locator');
      } else if (typeof field.label === 'string') loc = tab.playwright.getByLabel(field.label, { exact: true });
      else if (typeof field.locator === 'string') loc = tab.playwright.locator(field.locator);
      else loc = field.locator;
      if (!loc || await loc.count() !== 1) throw new Error('field must match exactly one control');
      const state = async () => {
        const meta = await loc.evaluate(el => ({
        tag: el.tagName?.toLowerCase(), type: el.type, role: el.getAttribute('role'), multiple: el.multiple === true,
        id: el.id, reflected: el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed'),
        checked: typeof el.checked === 'boolean' ? el.checked : undefined,
        readOnly: el.readOnly === true, popup: el.getAttribute('aria-haspopup'),
        value: el.value ?? el.getAttribute('aria-valuenow'),
        min: el.getAttribute('min') ?? el.getAttribute('aria-valuemin') ?? '0',
        max: el.getAttribute('max') ?? el.getAttribute('aria-valuemax') ?? '100',
        step: el.getAttribute('step') ?? '1',
        }), undefined, options);
        const native = meta.tag === 'input' && ['checkbox', 'radio'].includes(meta.type);
        meta.checkable = ['checkbox', 'radio'].includes(meta.type) ||
          ['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(meta.role) ||
          (typeof meta.tag === 'string' && meta.tag.includes('-') && typeof meta.checked === 'boolean') ||
          ['true', 'false'].includes(meta.reflected);
        if (meta.reflected !== null && meta.reflected !== undefined) meta.checked = meta.reflected;
        else if (!native && (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(meta.role) ||
            (typeof meta.tag === 'string' && meta.tag.includes('-') && typeof meta.checked === 'boolean'))) {
          meta.checked = undefined;
          let timer, ax;
          try {
            ax = await Promise.race([tab.getAXState({ disableDiffing: true, emit: false }),
              new Promise(resolve => { timer = setTimeout(resolve, 1000); })]);
          } catch {} finally { clearTimeout(timer); }
          const rows = typeof ax === 'string' ? ax.split('\n').filter(line => {
            if (!/^\t*\d+ (?:switch|checkbox|radio button|menuitemcheckbox|menuitemradio)\b/.test(line)) return false;
            const id = /\bID: (.*?)(?=, (?:Value|Help|Description):|$)/.exec(line)?.[1];
            return meta.id ? id === meta.id : typeof field.label === 'string' &&
              /\bDescription: (.*?)(?=, (?:Value|Help|ID):|$)/.exec(line)?.[1] === field.label;
          }) : [];
          if (rows.length === 1) {
            const value = /\bValue: (0|1|true|false)(?=, |$)/.exec(rows[0])?.[1];
            if (value !== undefined) { meta.checked = value === '1' || value === 'true'; meta.fromAX = true; }
          }
        }
        return meta;
      };
      const meta = await state();
      if (many && (meta.tag !== 'select' || !meta.multiple)) throw new Error('an array value needs a native multi-select');
      if (meta.checkable) {
        const on = typeof field.value === 'boolean' ? field.value :
          /^(?:true|on|yes|checked|1)$/i.test(String(field.value)) ? true :
            /^(?:false|off|no|unchecked|0)$/i.test(String(field.value)) ? false : undefined;
        if (on === undefined) throw new Error('checked value must be true or false');
        if (![true, false, 'true', 'false'].includes(meta.checked)) throw unverifiable();
        if (meta.fromAX) {
          // The engine's setChecked would read the isolated default getter, not this AX state: click once, read back.
          if (meta.checked !== on) {
            if (meta.role === 'radio' && !on) throw new Error('choose another radio option to uncheck this one');
            await loc.click(options);
            const after = (await state()).checked;
            if (![true, false, 'true', 'false'].includes(after)) throw unverifiable(true);
            if ((after === true || after === 'true') !== on) throw new Error('checked state did not match after clicking');
          }
        } else try { await loc.setChecked(on, options); }
        catch (error) {
          const now = (await state()).checked;
          if (![true, false, 'true', 'false'].includes(now)) throw unverifiable();
          if ((now === true || now === 'true') !== on) {
            if ((meta.type === 'radio' || meta.role === 'radio') && !on) throw new Error('choose another radio option to uncheck this one');
            await loc.click(options);
            const after = (await state()).checked;
            if (![true, false, 'true', 'false'].includes(after)) throw unverifiable(true);
            if ((after === true || after === 'true') !== on) throw new Error('checked state did not match after clicking');
          }
          fallback = 'checked state verified after fallback';
        }
      } else if (meta.tag === 'select') {
        const wanted = [...new Set(many ? field.value : [String(field.value)])];
        let key = 'label';
        const input = () => meta.multiple ? wanted.map(value => ({ [key]: value })) : { [key]: wanted[0] };
        try { await loc.selectOption(input(), options); }
        catch { key = 'value'; await loc.selectOption(input(), options); fallback = 'selected by value fallback'; }
        if (meta.multiple) {
          const selected = await loc.evaluate(el => Array.from(el.selectedOptions, option => ({ label: option.label, value: option.value })), undefined, options);
          if (selected.length !== wanted.length || wanted.some(value => !selected.some(option => option[key] === value))) {
            throw new Error('selected options did not match requested ' + key + 's');
          }
        }
      } else if (meta.type === 'range' || meta.role === 'slider') {
        const min = Number(meta.min), max = Number(meta.max), step = Number(meta.step), value = Number(field.value);
        const steps = (value - min) / step;
        if (![min, max, step, value, steps].every(Number.isFinite) || step <= 0 || value < min || value > max ||
            Math.abs(steps - Math.round(steps)) > 1e-8 || steps > 200) throw new Error('slider needs an in-range value within 200 steps of its minimum');
        await loc.press('Home', options);
        for (let n = 0; n < Math.round(steps); n++) await loc.press('ArrowRight', options);
        if (Number((await state()).value) !== value) throw new Error('slider value did not match; read the field before retrying');
      } else {
        if (['file', 'submit', 'reset', 'button', 'image', 'hidden'].includes(meta.type) || meta.role === 'button') {
          throw new Error('control is not a form value; fillForm never submits');
        }
        if (meta.readOnly) throw new Error('control is read-only; ' +
          (meta.popup && meta.popup !== 'false' ? 'use locator.click() to open its picker, then choose with locators' :
            'read the control to find its UI input path'));
        try { await loc.fill(String(field.value), options); }
        catch {
          if (meta.role === 'combobox' && meta.tag !== 'input' && meta.tag !== 'textarea') {
            await loc.click(options);
            await tab.playwright.getByRole('option', { name: String(field.value), exact: true }).click(options);
          } else {
            await loc.press('ControlOrMeta+A', options);
            await loc.type(String(field.value), options);
          }
          fallback = 'filled with fallback';
        }
      }
      filled++;
      if (fallback) notes.push(`Field ${i + 1} (${name}): ${fallback}.`);
    } catch (error) {
      if (error.unverifiable) notes.push(`Field ${i + 1} (${name}) unverifiable: ${error.message}`);
      else notes.push(`Field ${i + 1} (${name}) failed: ${String(error.message).replace(/\s+/g, ' ')}. Input may have been sent; read this field before retrying.`);
    }
  }
  return `Filled ${filled} of ${fields.length} fields.` + (notes.length ? '\n' + notes.join('\n') : '');
}

export function fillFormCode(code, force = false) {
  if (!force && !/\bsleight\s*\.\s*fillForm\s*\(/.test(code)) return code;
  return `globalThis.sleight ??= {}; globalThis.sleight.fillForm = (${fillForm.toString()});\n${code}`;
}

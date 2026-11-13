// Data-only desktop substitutes. Optional app routes fake browser inputs through
// the real runtime facade; no browser, process or desktop provider is created.
export function formFixture(specs, app) {
  const calls = [];
  const controls = Object.fromEntries(Object.entries(specs).map(([name, spec], index) => {
    const el = { tagName: 'INPUT', type: 'text', value: '', checked: false,
      getAttribute: key => spec[key] ?? null, ...spec };
    const input = async (operation, value) => {
      if (app) {
        if (operation === 'press') await app.pressKey(value);
        else if (operation === 'click') await app.click(index + 1);
        else await app.setValue(index + 1, typeof value === 'object' ? value.label ?? value.value : value);
      }
      calls.push([name, operation, ...value === undefined ? [] : [value]]);
    };
    return [name, {
      count: async () => spec.count ?? 1,
      evaluate: async (fn, arg) => fn(el, arg),
      fill: async value => { await input('fill', value); if (spec.fillError) throw Error(spec.fillError); el.value = value; },
      type: async value => { await input('type', value); el.value = value; },
      press: async key => {
        await input('press', key);
        if (key === 'Home') el.value = spec.min ?? 0;
        if (key === 'ArrowRight') el.value = Number(el.value) + Number(spec.step ?? 1);
      },
      setChecked: async value => { await input('check', value); if (spec.checkError) throw Error(spec.checkError); el.checked = value; },
      click: async () => { await input('click'); el.checked = !el.checked; },
      selectOption: async value => { await input('select', value); if (spec.labelError && value.label) throw Error('no option label'); },
    }];
  }));
  const tab = { playwright: { getByLabel: name => controls[name], locator: name => controls[name] },
    getAXState: async () => 'Browser tab: 1, Title: "Form", URL: "https://example.com".\n0 AXWebArea Form\n\t1 text field Description: Name, ID: name\n\t2 checkbox Description: Terms' };
  return { tab, calls };
}

export function dragFixture(source, target, app) {
  const calls = [];
  const root = { tagName: 'HTML', clientWidth: 1000, clientHeight: 1000, children: [], parentElement: null };
  const parent = { tagName: 'UL', id: 'list', children: [], parentElement: root };
  root.children = [parent];
  const make = (id, rect) => ({ id, tagName: 'LI', textContent: id, parentElement: parent,
    getBoundingClientRect: () => rect });
  const from = make('source', source), to = make('target', target);
  parent.children = [to, from];
  const document = { documentElement: root, scrollingElement: root, getElementsByTagName: () => parent.children };
  const window = { getComputedStyle: () => ({ overflowY: 'visible' }) };
  const evaluate = (fn, el, arg) => Function('document', 'window', 'el', 'arg', `return (${fn.toString()})(el, arg)`)(document, window, el, arg);
  const loc = el => ({ count: async () => el ? 1 : 0, evaluate: async (fn, arg) => evaluate(fn, el, arg) });
  const tab = { playwright: {
    locator: name => loc(name === '#source' ? from : name === '#target' ? to : null),
    evaluate: async (fn, arg) => evaluate(fn, arg),
  }, drag: async (a, b) => { if (app) await app.drag(a, b); calls.push([a, b]); parent.children = [from, to]; } };
  return { tab, calls };
}

export function browserListFixture(names, app) {
  let selected;
  const calls = [];
  const rows = names.map(name => ({ textContent: name, innerText: name, selected: false,
    getAttribute: () => null, getBoundingClientRect: () => ({ x: 10, y: 10, width: 100, height: 20 }),
    scrollIntoView() {} }));
  const element = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 200, height: 200 }),
    scrollTop: 0, scrollHeight: 200, clientHeight: 200, querySelectorAll: () => rows };
  const document = { documentElement: { clientWidth: 1000, clientHeight: 1000 } };
  const loc = { count: async () => 1,
    evaluate: async (fn, arg) => Function('document', 'el', 'arg', `return (${fn.toString()})(el, arg)`)(document, element, arg),
    getByRole: (_role, { name }) => ({ count: async () => rows.filter(row => row.textContent === name).length,
      async click() {
        if (app) await app.click(names.indexOf(name) + 1);
        calls.push(['click', name]); selected = name;
        for (const row of rows) row.selected = row.textContent === selected;
      } }),
  };
  return { tab: { playwright: { locator: () => loc }, cua: { scroll: async () => { throw Error('unexpected scroll'); } } }, calls };
}

// No host access. The serialized picker receives only ordinary facade methods.
export function nativeListPicker({ app, kit, run, current, lock, text, clicked }) {
  return (...args) => run('pickFromList', async () => {
    const release = lock(current());
    const seen = kit.elements(text());
    const resolve = line => {
      const matches = [...kit.elements(text())].filter(([, body]) => body === line);
      if (matches.length !== 1) throw Error('STALE_READ');
      // Keep ordinary retained-number checks, including refusal of a helper row
      // whose number has not been delivered. Never grant an internal baseline.
      return matches[0][0];
    };
    try {
      const result = await kit.listPicker({
        read: () => app.getAXState({ emit: false, disableDiffing: true }),
        observe() {}, parse: kit.parse, sameElement: kit.sameElement,
        expected: kit.parse(text()), clicked: clicked(), lineSeen: number => seen.get(number),
        uniqueSeen: number => [...seen.values()].filter(line => line === seen.get(number)).length === 1,
        press: key => app.pressKey(key),
        scroll: (line, direction, ticks) => app.scroll(resolve(line), direction, ticks),
        click: line => app.click(resolve(line)),
      })(...args);
      if (!result.clicked) throw Error('pickFromList stopped (' + result.reason + '): ' + result.note +
        ' [' + result.reads + ' reads, ' + result.keys + ' keys]');
      return result;
    } finally { release(); }
  });
}

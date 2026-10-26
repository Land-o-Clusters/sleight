// Tab: the wildcard. A paper-cutout robot with a screen face, a warm file-folder tab on its head and a cool antenna.
// Error swaps the sweat drop for a strip of masking tape.
export default {
  id: 'tab',
  name: 'Tab',
  personality: 'A folded-paper robot who never misses a tab stop and tapes up its own mistakes.',
  description: 'Paper-cutout robot with a screen face and a file-folder tab. Drawn in code for sleight.',
  author: 'sleight',
  license: 'MIT',
  seat: 148, // perch mode (A2): the cell y that rests on the window's top edge
  style: 'paper',
  E: 0.9,
  ink: '#2a2238',
  pal: {
    head: { base: '#f6efe2', shade: '#e4d8c2' },
    body: { base: '#8fb0f2', shade: '#7393db' },
    limb: { base: '#efe6d4', shade: '#dccfb6' },
    hand: { base: '#f6efe2', shade: '#e0d3bb' },
    leg: { base: '#3d4766', shade: '#2f3852' },
    foot: { base: '#3d4766', shade: '#2c3449' },
    tab: { base: '#ff8a4c', shade: '#d9672e' },
    bulb: { base: '#5b8dff', shade: '#3f6ce0' },
    label: { base: '#fffdf8' }, labelMark: '#ff8a4c', labelLine: '#b4b0a6',
  },
  screen: { base: '#26304b', glare: '#323e5f', face: '#dff1ff', blush: '#ff9aa2', ink: '#2a2238' },
};

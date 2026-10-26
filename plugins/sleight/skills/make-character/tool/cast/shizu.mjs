// Shizu: calm and precise. A different silhouette from Tsugi: a long straight hime cut and an A-line coat
// make a tall rectangle where Tsugi is a round, spiky one. Smaller motions (E 0.6) and softer expressions.
export default {
  id: 'shizu',
  name: 'Shizu',
  personality: 'Calm and precise. Measures twice and clicks once.',
  description: 'Calm, precise assistant with a long straight bob, round glasses and a slate coat. Drawn in code for sleight.',
  author: 'sleight',
  license: 'MIT',
  seat: 150, // perch mode (A2): the cell y that rests on the window's top edge
  style: 'anime',
  E: 0.6,
  ink: '#22283a',
  rim: 1.5,
  sticker: 2.2, // soft light rim outside the ink line so dark parts survive dark windows
  stickerColor: 'rgba(230,233,242,0.6)',
  // Calm defaults: eyes rest slightly lidded, big grins become small open smiles, shouts become an "oh".
  expr: { open: 'calm', grin: 'smile2', shout: 'open', teeth: 'flat', tongue: 'flat', up: 'calm' },
  skin: { base: '#f2c9a8', shade: '#d69b78', light: '#fbe2cf', line: '#7a4a38' },
  blush: '#f08a84',
  brow: '#1b2c36',
  mouth: '#6a2b36',
  lash: 3,
  iris: { base: '#33ad94', shade: '#1b6b5c', light: '#9ce8d3', pupil: '#0f2f2a' },
  glasses: { frame: '#34404f', tint: '#dff3ff' },
  hair: {
    style: 'hime', clip: 'bar', clipColor: '#4fd0ad',
    pal: { base: '#38596c', shade: '#223a4a', light: '#7fb0c2', line: '#15232d' },
  },
  outfit: {
    style: 'longcoat', cuffs: 'band',
    body: { base: '#9aa3cf', shade: '#7079ad', light: '#c3c9ea', line: '#22283a' },
    sleeve: { base: '#9aa3cf', shade: '#7079ad', light: '#c3c9ea', line: '#22283a' },
    cuff: { base: '#c3c9ea', shade: '#9aa3cf', light: '#ffffff', line: '#22283a' },
    shirt: { base: '#ffffff', shade: '#dfe3ee', light: '#ffffff', line: '#22283a' },
    accent: { base: '#3fc2a0', shade: '#25876f', light: '#9ff0d8', line: '#22283a' },
  },
  legs: {
    pants: { base: '#3c4255', shade: '#2a2f3e', light: '#56607a', line: '#22283a' },
    shoes: { base: '#6b4a3c', shade: '#3e2a22', light: '#9a7462', line: '#22283a' },
  },
  props: { keyboard: { base: '#34404f', shade: '#232c38', light: '#4f5f73', line: '#22283a' } },
};

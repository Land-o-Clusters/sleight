// Kit: the mascot creature. A chibi fox drawn with the anime renderer's fox head: warm fur, cool-tipped ears and
// tail (the icon's two colors), a cool bandana, dark paws. Big tail, big reactions.
export default {
  id: 'kit',
  name: 'Kit',
  personality: 'A small fox with a very large tail, who cheers every finished task as if it won a prize.',
  description: 'Mascot fox with warm fur and cool-tipped ears and tail. Drawn in code for sleight.',
  author: 'sleight',
  license: 'MIT',
  seat: 164, // perch mode (A2): the cell y that rests on the window's top edge
  style: 'anime',
  species: 'fox',
  E: 1.1,
  // Mascot build: short legs, the head sits a little lower, so it reads as a creature, not a person in a fox suit.
  build: { hipY: 164, leg: 23, headY: 72, shY: 114 },
  ink: '#2a2238',
  rim: 1.5,
  sticker: 2.2,
  stickerColor: 'rgba(230,233,242,0.6)',
  expr: { smile: 'cat' },
  skin: { base: '#f58a42', shade: '#cc6127', light: '#ffc08c', line: '#7a3414' },
  neck: { base: '#f58a42', shade: '#cc6127', light: '#ffc08c', line: '#7a3414' },
  muzzle: { base: '#fff6ea', shade: '#efd9c4', light: '#ffffff', line: '#7a3414' },
  hands: { base: '#4a3236', shade: '#2f1f24', light: '#6b4e52', line: '#2a2238' },
  ears: { inner: { base: '#ffe1cf', shade: '#f2c0a6', light: '#fff', line: '#7a3414' }, tip: { base: '#5b8dff', shade: '#3a62d6' } },
  tail: { pal: { base: '#f58a42', shade: '#cc6127', light: '#ffc08c', line: '#7a3414' }, tip: { base: '#7aa2ff', shade: '#4a72e0', light: '#bcd0ff', line: '#1f2a6e' } },
  blush: '#ff8f9a',
  brow: '#8a3a18',
  mouth: '#6e2a3c',
  iris: { base: '#4f86f0', shade: '#2a47ad', light: '#b5d0ff', pupil: '#121736' },
  hair: { style: 'fox' },
  outfit: {
    style: 'fur', cuffs: 'none',
    body: { base: '#f58a42', shade: '#cc6127', light: '#ffc08c', line: '#7a3414' },
    sleeve: { base: '#f58a42', shade: '#cc6127', light: '#ffc08c', line: '#7a3414' },
    belly: { base: '#fff6ea', shade: '#efd9c4', light: '#ffffff', line: '#7a3414' },
    scarf: { base: '#5b8dff', shade: '#3a62d6', light: '#a8c2ff', line: '#1f2a6e' },
  },
  legs: {
    pants: { base: '#4a3236', shade: '#2f1f24', light: '#6b4e52', line: '#2a2238' },
    shoes: { base: '#4a3236', shade: '#2f1f24', light: '#6b4e52', line: '#2a2238' },
  },
};

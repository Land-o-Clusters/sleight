// Tsugi: the lead. Named for the seam where two pieces join (kintsugi), like the icon's two hands and the ring's halves.
// Ties to the icon: hair split warm (viewer's left) and cool (right), heterochromia to match, sleeves that dissolve
// into warm and cool pixels at the wrists, a white spark hair clip and a pointer badge.
export default {
  id: 'tsugi',
  name: 'Tsugi',
  personality: 'A cheerful engineer who gives every finished click a thumbs-up and hands the pointer back with a grin.',
  description: 'Cheerful engineer mascot with warm and cool split hair and pixel cuffs. Drawn in code for sleight.',
  author: 'sleight',
  license: 'MIT',
  seat: 150, // perch mode (A2): the cell y that rests on the window's top edge
  style: 'anime',
  E: 1,
  ink: '#2a2238',
  rim: 1.5,
  sticker: 2.2, // soft light rim outside the ink line so dark parts survive dark windows
  stickerColor: 'rgba(230,233,242,0.6)',
  skin: { base: '#ffe7d8', shade: '#f6b9a1', light: '#fff5ee', line: '#8a4f45' },
  blush: '#ff8f9a',
  brow: '#5a3340',
  mouth: '#6e2a3c',
  iris: {
    l: { base: '#f0973a', shade: '#a9541f', light: '#ffd58a', pupil: '#3a1d18' },
    r: { base: '#5584f0', shade: '#2a47ad', light: '#a9c8ff', pupil: '#16193f' },
  },
  hair: {
    style: 'spiky', split: true, ahoge: true, clip: 'spark',
    palL: { base: '#f4874f', shade: '#cc5a2e', light: '#ffc79e', line: '#6e2a1c' },
    palR: { base: '#6a8ef2', shade: '#4462c7', light: '#bcd0ff', line: '#1f2a6e' },
  },
  outfit: {
    style: 'jacket', badge: true, cuffs: 'pixels',
    body: { base: '#f5f0e6', shade: '#d6cab6', light: '#ffffff', line: '#2a2238' },
    sleeve: { base: '#f5f0e6', shade: '#d6cab6', light: '#ffffff', line: '#2a2238' },
    accent: { base: '#2f3658', shade: '#1f2442', light: '#4a547f', line: '#2a2238' },
  },
  legs: {
    pants: { base: '#353d61', shade: '#242a47', light: '#4d5784', line: '#2a2238' },
    shoes: { base: '#2a2238', shade: '#ffffff', light: '#5a5470', line: '#2a2238' },
  },
};

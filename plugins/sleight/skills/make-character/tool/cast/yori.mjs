// Yori: the adult professional. Same anime renderer with an adult build: a smaller head (0.76), longer limbs and
// neck, about 3 heads tall, a narrower chin and less round eyes. Modest suit, a spark lapel pin, a low side ponytail.
export default {
  id: 'yori',
  name: 'Yori',
  personality: 'A senior engineer, cool under pressure, who explains the fix in one sentence and then makes it.',
  description: 'Cool, confident adult engineer in a dark suit with a low side ponytail. Drawn in code for sleight.',
  author: 'sleight',
  license: 'MIT',
  seat: 142, // perch mode (A2): the cell y that rests on the window's top edge
  style: 'anime',
  E: 0.8,
  ink: '#211f30',
  rim: 1.5,
  sticker: 2.2,
  stickerColor: 'rgba(230,233,242,0.6)',
  build: { hipY: 142, shY: 94, headY: 58, leg: 45, upper: 19, fore: 17, head: 0.76, shoulder: 17, hipW: 8.5, limb: 0.86, neck: [76, 92] },
  faceShape: { chin: 36, cheek: 21, jaw: 11 },
  eye: { w: 15, h: 15.8 },
  irisScale: 0.86,
  lash: 2.4,
  nose: true,
  mouthY: 22,
  // Confident, not cute: small open eyes by default, a smirk where others grin, no open-mouthed shouting.
  expr: { open: 'soft', grin: 'smirk', shout: 'open', teeth: 'flat', tongue: 'flat', smile2: 'smirk' },
  skin: { base: '#c98a62', shade: '#a56a46', light: '#dda27c', line: '#5e3322' },
  blush: '#d9736a',
  brow: '#1d1c33',
  mouth: '#5a2230',
  iris: { base: '#d99a34', shade: '#8a5518', light: '#ffd98e', pupil: '#2a1608' },
  hair: {
    style: 'sleek',
    pal: { base: '#34345a', shade: '#22213e', light: '#8384c2', line: '#15142a' },
    tie: { base: '#5b8dff', shade: '#3a62d6', light: '#a8c2ff', line: '#211f30' },
  },
  outfit: {
    style: 'suit', cuffs: 'band',
    body: { base: '#3c4658', shade: '#2a3242', light: '#56627a', line: '#211f30' },
    sleeve: { base: '#3c4658', shade: '#2a3242', light: '#56627a', line: '#211f30' },
    lapel: { base: '#323b4c', shade: '#232a37', light: '#4a5468', line: '#211f30' },
    cuff: { base: '#ffffff', shade: '#dfe3ee', light: '#ffffff', line: '#211f30' },
    shirt: { base: '#ffffff', shade: '#dfe3ee', light: '#ffffff', line: '#211f30' },
  },
  legs: {
    pants: { base: '#2c3340', shade: '#1e232d', light: '#444e60', line: '#211f30' },
    shoes: { base: '#1f1c2a', shade: '#6a6680', light: '#4a4660', line: '#211f30' },
  },
};

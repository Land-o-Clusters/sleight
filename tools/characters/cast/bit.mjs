// Bit: a pixel-art critter that is a mouse in both senses. Left button warm, right button cool, a scroll wheel on the
// seam between them, round ears, and a cable tail with a plug. 32-pixel grid at 6x.
export default {
  id: 'bit',
  name: 'Bit',
  personality: 'A pocket-sized mouse (both kinds) who runs on curiosity and one very busy scroll wheel.',
  description: 'Pixel-art computer-mouse critter with a warm left button, a cool right button and a cable tail. Drawn in code for sleight.',
  author: 'sleight',
  license: 'MIT',
  seat: 176, // perch mode (A2): the cell y that rests on the window's top edge
  style: 'pixel',
  E: 1,
  ink: '#2a2238',
  pal: {
    shell: { base: '#f4f1ea', shade: '#cdc5b6', light: '#ffffff', group: 'body' },
    btnW: { base: '#ff7a3d', shade: '#d4531f', light: '#ffb08a', group: 'body' },
    btnC: { base: '#5b8dff', shade: '#3a62d6', light: '#a8c2ff', group: 'body' },
    seam: '#3a3550', rim: '#8e8597', wheel: '#3a3550', wheelB: '#9aa0b8',
    earW: '#ffb08a', earC: '#a8c2ff',
    eye: '#2a2238', eyeHi: '#ffffff', mouth: '#2a2238', mouthIn: '#8a2a3a', tongue: '#ff8d8d', teeth: '#ffffff', blush: '#ff9aa2',
    foot: { base: '#5d5775', shade: '#46405c', light: '#7d7896' },
    cable: '#6a6484', plug: '#d9dde6',
    kb: '#2c3352', key: '#e9ebf3', card: '#fbfbfd', stripe: '#f5a524', cardLine: '#a3a8b8', board: '#b9825a',
  },
};

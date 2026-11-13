// Broad muzzle, floppy ears, feathery tail and a blue collar, never a vest.
import { renderCritter } from '../rigs/critter.mjs';
export default {
  id: 'biscuit', name: 'Biscuit', style: 'toon', rig: renderCritter, species: 'dog',
  description: 'An eager golden retriever who thinks every click is a ball. Drawn in code for sleight.',
  personality: 'Every task might be fetch. Ready either way.',
  author: 'sleight', license: 'MIT', seat: 150, E: 1,
  ink: '#382c31', fur: '#e5ad55', shade: '#bc7b39', light: '#ffe1a1',
  warm: '#ed9655', cool: '#5c91cd', iris: '#614b38',
  motion: { travel: 'arc', tempo: 1 },
};

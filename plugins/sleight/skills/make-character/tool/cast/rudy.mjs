// Two rubber shapes and a beak. No costume or limbs.
import { renderCritter } from '../rigs/critter.mjs';
export default {
  id: 'rudy', name: 'Rudy', style: 'toon', rig: renderCritter, species: 'duck',
  description: 'A yellow rubber duck. Listens. Drawn in code for sleight.',
  personality: 'A good listener with very little to add.',
  author: 'sleight', license: 'MIT', seat: 150, E: 0,
  ink: '#40332b', fur: '#f6cf4e', shade: '#daa736', light: '#ffe999',
  warm: '#ed9950', cool: '#7298cf', iris: '#292938',
  motion: { travel: 'pop', tempo: 1, quacksPerTurn: 1 },
};

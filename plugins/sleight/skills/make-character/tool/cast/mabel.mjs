// Round tabby, white bib and striped tail. No borrowed mascot design.
import { renderCritter } from '../rigs/critter.mjs';
export default {
  id: 'mabel', name: 'Mabel', style: 'toon', rig: renderCritter, species: 'cat',
  description: 'A gray tabby who treats every window as furniture. Drawn in code for sleight.',
  personality: 'Interested in the ring, unimpressed by everything else.',
  author: 'sleight', license: 'MIT', seat: 150, E: 0.65,
  ink: '#292938', fur: '#969aa8', shade: '#686c80', light: '#f4f1e8',
  warm: '#dd8b54', cool: '#688bd0', iris: '#b5c875',
  motion: { travel: 'arc', tempo: 1 },
};

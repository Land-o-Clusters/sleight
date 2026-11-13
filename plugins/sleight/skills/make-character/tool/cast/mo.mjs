// Long hooked limbs, a pale oval mask and dark eye patches.
import { renderCritter } from '../rigs/critter.mjs';
export default {
  id: 'mo', name: 'Mo', style: 'toon', rig: renderCritter, species: 'sloth',
  description: 'A sloth who arrives by popping in and takes his time. Drawn in code for sleight.',
  personality: 'The agent is fast. Mo has other priorities.',
  author: 'sleight', license: 'MIT', seat: 64, E: 0.3,
  ink: '#352d35', fur: '#a48c7b', shade: '#796759', light: '#e8dcc3',
  warm: '#d39762', cool: '#748cbd', iris: '#3f3532',
  motion: { travel: 'pop', tempo: 2, climbPointsPerMs: 0.2 },
};

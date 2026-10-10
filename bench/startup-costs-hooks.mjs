// Registers the counting hooks for bench/startup-costs-count.mjs. Loaded with
// node --import before the bench child runs.
import { register } from 'node:module';
register('./startup-costs-intercept.mjs', import.meta.url);

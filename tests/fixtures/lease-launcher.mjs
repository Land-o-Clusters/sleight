// Runs the real launcher with a private test lease bank and a fake engine.
import { run } from '../../plugins/sleight/lib/launch.mjs';
run({ leaseDirectory: process.argv[2] });

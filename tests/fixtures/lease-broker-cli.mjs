// Only offline tests choose a store and clock. The public CLI has no root override.
import { runBrokerCLI } from '../../plugins/sleight/lib/lease-broker-cli.mjs';
process.exitCode = await runBrokerCLI({ directory: process.argv[2], now: () => Number(process.argv[3]) });
if (process.argv[4] === 'crash' && process.exitCode === 0) throw new Error('simulated outside-client crash after acquire');

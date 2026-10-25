// A dry plan must survive with every mutation, subprocess and socket boundary closed.
import fs from 'node:fs';
import promises from 'node:fs/promises';
import childProcess from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
const denied = () => { throw Error('LC1 dry run attempted a side effect'); };
const openSync = fs.openSync.bind(fs), open = promises.open.bind(promises);
fs.openSync = (path, flags, ...args) => flags === 'r' || flags === 0 ? openSync(path, flags, ...args) : denied();
promises.open = (path, flags, ...args) => flags === 'r' || flags === 0 ? open(path, flags, ...args) : denied();
for (const key of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync', 'existsSync']) fs[key] = denied;
for (const key of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'stat', 'lstat']) promises[key] = denied;
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[key] = denied;
net.connect = denied; net.createConnection = denied; net.Server.prototype.listen = denied;
http.request = denied; http.get = denied; globalThis.WebSocket = denied;
syncBuiltinESMExports();

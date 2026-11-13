// Own one offline helper. Its fake AX write pauses until this parent dies.
import { spawn } from 'node:child_process';
let input = '';
for await (const bytes of process.stdin) input += bytes;
const { binary, request } = JSON.parse(input);
const helper = spawn(binary, [], { stdio: ['pipe', process.stdout, 'pipe'], timeout: 10000 });
helper.once('error', error => { throw error; });
let stderr = '';
helper.stderr.on('data', bytes => {
  stderr += bytes;
  if (stderr.includes('renderer-write-ready\n')) process.kill(process.pid, 'SIGKILL');
});
helper.once('close', code => { process.exitCode = code ?? 1; });
helper.stdin.end(JSON.stringify(request) + '\n');

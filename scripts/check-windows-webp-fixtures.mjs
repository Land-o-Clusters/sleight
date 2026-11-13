// Verify the synthetic VP8L fixtures with macOS ImageIO, without a window.
// This validates the fixture bytes, not the Windows C# implementation.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTemp } from './temp-leftovers.mjs';
import { webpCases } from '../tests/fixtures/windows-webp-fixture.mjs';

if (process.platform !== 'darwin') throw Error('Fixture QA requires macOS.');
const root = realpathSync(mkdtempSync('/tmp/sleight-webp-fixtures-'));
const binary = join(root,'check'), cache = join(root,'modules'); mkdirSync(cache);
let child, interrupted;
const stop = signal => { interrupted = true; child?.kill(signal); };
for (const signal of ['SIGINT','SIGTERM','SIGHUP']) process.on(signal,stop);
function run(file,args,input='') {
  if (interrupted) throw Error('Interrupted');
  return new Promise((resolve,reject) => {
    let out='',err='',failure;
    const proc=child=spawn(file,args,{stdio:['pipe','pipe','pipe']});
    const timer=setTimeout(()=>{failure=Error('Fixture child timed out');proc.kill();},300000);
    proc.stdout.on('data',b=>{out+=b;if(out.length>16<<20){failure=Error('Fixture output limit');proc.kill();}});
    proc.stderr.on('data',b=>{err+=b.toString().slice(0,4096-err.length);});
    proc.once('error',e=>{failure=e;});
    proc.once('close',code=>{clearTimeout(timer);child=undefined;if(failure||code!==0||interrupted)reject(failure??Error('Fixture child exit '+code+': '+err));else resolve(out);});
    proc.stdin.on('error',()=>{});proc.stdin.end(input);
  });
}
try {
  const fixtures=webpCases();
  await run('/usr/bin/xcrun',['swiftc','-module-cache-path',cache,fileURLToPath(new URL('../tests/fixtures/windows-webp-check.swift',import.meta.url)),'-o',binary]);
  let passed=0;
  for(const fixture of fixtures) {
    const decoded=Buffer.from((await run(binary,[],fixture.bytes.toString('base64')+'\n')).trim(),'base64');
    if(decoded.length!==fixture.expected.length)throw Error(fixture.name+': length');
    for(let i=0;i<decoded.length;i++)if(Math.abs(decoded[i]-fixture.expected[i])>1)throw Error(fixture.name+': pixel byte '+i+' ('+decoded[i]+' vs '+fixture.expected[i]+')');
    passed++;
  }
  console.log(JSON.stringify({fixtures:fixtures.length,pass:passed,fail:0,decoder:'macOS ImageIO, fixture QA only'}));
} finally {
  for (const signal of ['SIGINT','SIGTERM','SIGHUP']) process.off(signal,stop);
  removeTemp(root);
}

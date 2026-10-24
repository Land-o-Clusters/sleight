// Host-only synthetic native/package providers around the actual installed v3
// worker. Browser pages, filter, snapshots, actions, fill and trust join are real.
import { Socket } from 'node:net';
import { createUiChannel } from '../../plugins/sleight/lib/direct-browser/host.mjs';
import { writeFileSync } from 'node:fs';
import { startInstalledV3Worker } from '../../plugins/sleight/lib/direct-browser/worker.mjs';
import { createCDPFilter } from '../../plugins/sleight/lib/direct-browser/cdp-filter.mjs';

const [endpoint, receiptPath] = process.argv.slice(2);
if (process.env.SLEIGHT_LIVE_DOM_TEST !== '1' || !/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-z0-9-]+$/i.test(endpoint)) throw Error('host fixture required');
let socket, serial = 0, disconnected = false;
const pending = new Map(), listeners = new Set(), losses = new Set(), wire = [], filters = [];
const raw = { sessionId:'root',
  on(name,fn) { if(name!=='event') throw Error('unsupported fixture subscription'); listeners.add(fn); },
  off(name,fn) { if(name!=='event') throw Error('unsupported fixture subscription'); listeners.delete(fn); },
  send(method,params={},route='root') {
    if(socket?.readyState!==1) return Promise.reject(Error('fixture closed'));
    wire.push({method,params});const id=++serial;
    return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,...(route==='root'?{}:{sessionId:route})}));});
  },
};
const selected = {selectedBrowser:'bfixture',session:raw,endpoint,
  async connect() {
    socket=new WebSocket(endpoint);
    socket.addEventListener('message',e=>{const frame=JSON.parse(e.data);if(frame.id){const entry=pending.get(frame.id);pending.delete(frame.id);if(frame.error)entry.reject(Error(frame.error.message));else entry.resolve(frame.result);}else for(const fn of listeners)fn(frame);});
    socket.addEventListener('close',()=>{disconnected=true;for(const entry of pending.values())entry.reject(Error('fixture closed'));pending.clear();for(const fn of losses)fn();});
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});return raw;
  },
  verifyConnection:async session=>session===raw&&socket?.readyState===1,
  async disconnect(){if(!socket||disconnected)return true;await new Promise(resolve=>{socket.addEventListener('close',resolve,{once:true});socket.close();});return disconnected;},
  onConnectionLoss(fn){losses.add(fn);return()=>losses.delete(fn);},
  createFilter(){const filter=createCDPFilter({session:raw,protectedPort:Number(new URL(endpoint).port)});filters.push(filter);return filter;},
};
let uiClosed=false;
const pipe=new Socket({fd:4});
const host = await startInstalledV3Worker({channel:process},{
  recoverClipboard: async () => {},
  onError:error=>process.stderr.write('Installed fixture startup: '+error.message+'\n'),
  readConfig:()=>({}),acceptPackage:()=>({current:()=>true}),
  prepareHelpers:async()=>({status:'ready',receipt:{}}),selectConnection:async()=>selected,
  createUi:(_receipt,onLoss)=>{const ui=createUiChannel({read:pipe,write:pipe,onLoss});return {...ui,close(){uiClosed=true;ui.close();pipe.destroy();}};},
});
host.closed.then(result=>{
  writeFileSync(receiptPath,JSON.stringify({result,disconnected,uiClosed,wire,filters:filters.length}));
  if(result.cleanup.length)process.exitCode=1;
});

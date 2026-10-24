import { randomUUID } from 'node:crypto';
import { hookProof, hookOpen } from './page.mjs';

export async function guardWholeRead(entry, deadline, bank) {
  const {page,hook}=entry,token=randomUUID();
  if(!hook)throw Error('whole guard unavailable');
  const pending=new Set(),tasks=new Set(),requests=new Map(),clickWindows=[];
  let session,armed=false,closed=false,bypassed=false;
  const call=async(method,...args)=>{
    const expression=`window[${JSON.stringify(hook.key)}]?.[${JSON.stringify(method)}]?.(${[hookProof(hook,method),...args].map(value=>JSON.stringify(value)).join(',')})`;
    const reply=await session.send('Runtime.evaluate',{expression,returnByValue:true,timeout:1000});
    if(reply.exceptionDetails)throw Error('whole guard unavailable');
    return hookOpen(hook,reply.result?.value);
  };
  const blocked=kind=>{if(bank.blocked.length<100&&!bank.blocked.includes(kind))bank.blocked.push(kind);};
  const requested=request=>{if(request.method()==='GET'&&['xhr','fetch'].includes(request.resourceType()))pending.add(request);};
  const finished=request=>pending.delete(request);
  // Network's wall time identifies initiation, even if Fetch delivery is delayed.
  // Retain the native initiator stack for attribution without exposing page URLs.
  const initiated=event=>{
    if(requests.size>=2048)requests.delete(requests.keys().next().value);
    requests.set(event.requestId,{at:event.wallTime*1000,initiator:event.initiator});
  };
  const done=event=>requests.delete(event.requestId);
  const originOf=url=>{try{return new URL(url).origin;}catch{return 'unknown origin';}};
  const paused=event=>{
    const observed=Date.now(),native=requests.get(event.networkId);
    const at=Number.isFinite(native?.at)?native.at:observed;
    const afterClick=clickWindows.some(({start,end})=>at>=start&&at<=end);
    const method=event.request.method;
    const preflight=method==='OPTIONS'&&Object.entries(event.request.headers??{}).some(([name,value])=>name.toLowerCase()==='access-control-request-method'&&String(value).toUpperCase()==='GET');
    const task=(async()=>{
      if(event.resourceType==='Document') {
        blocked('navigation');
        await session.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:204});
      } else if(method!=='GET'&&!preflight&&afterClick) {
        const attribution=native?.initiator?.stack?.callFrames?.length?' (expander window; script initiator)':' (expander window)';
        blocked(method+' '+originOf(event.request.url)+attribution);
        await session.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'});
      } else await session.send('Fetch.continueRequest',{requestId:event.requestId});
    })().catch(()=>{blocked('request guard unavailable');});
    tasks.add(task);task.finally(()=>tasks.delete(task));
  };
  const navigated=frame=>{if(frame===page.mainFrame())blocked('document or URL changed');};
  const dialog=()=>{blocked('dialog pending; no answer sent');};
  async function close(){
    if(closed)return;closed=true;
    let failure;
    // A time/item cap cannot shorten a click's two-second protection window.
    // Input completion may extend the window while this drain is waiting.
    for(;;){const remaining=Math.max(0,...clickWindows.map(window=>window.end-Date.now()));if(!remaining)break;await new Promise(resolve=>setTimeout(resolve,remaining));}
    if(armed){try{const report=await call('wholeTake');if(report)blocked(report);if(await call('whole',token,0)!==true)throw Error('whole guard release');}catch(e){failure=e;}}
    if(session){
      await Promise.allSettled([...tasks]);
      try{await session.send('Fetch.disable');}catch(e){failure??=e;}
      if(bypassed)try{await session.send('Network.setBypassServiceWorker',{bypass:false});}catch(e){failure??=e;}
      session.off('Fetch.requestPaused',paused);session.off('Network.requestWillBeSent',initiated);
      session.off('Network.loadingFinished',done);session.off('Network.loadingFailed',done);
      await session.detach().catch(()=>{});
    }
    page.off('request',requested);page.off('requestfinished',finished);page.off('requestfailed',finished);
    page.off('framenavigated',navigated);page.off('dialog',dialog);
    if(failure)throw failure;
  }
  try{
    session=await page.context().newCDPSession(page);
    // Own the bypass on this tab for the read. Without it, even a GET can ask
    // a controlling worker to issue a POST outside this target's interception.
    try{await session.send('Network.setBypassServiceWorker',{bypass:true});bypassed=true;}
    catch{throw Error('whole guard service worker bypass unavailable');}
    if(await call('whole',token,Math.max(1,Math.min(125000,deadline-Date.now()+4000)))!==true)throw Error('whole guard refused');
    armed=true;
    page.on('request',requested);page.on('requestfinished',finished);page.on('requestfailed',finished);
    session.on('Network.requestWillBeSent',initiated);session.on('Network.loadingFinished',done);session.on('Network.loadingFailed',done);
    await session.send('Network.enable');
    session.on('Fetch.requestPaused',paused);
    await session.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
    page.on('framenavigated',navigated);page.on('dialog',dialog);
    return {pending:()=>pending.size>0,
      expanderClick(){const start=Date.now(),window={start,end:start+2000};clickWindows.push(window);if(clickWindows.length>100)clickWindows.shift();return ()=>{window.end=Math.max(window.end,Date.now()+2000);};},
      async poll(){const report=await call('wholeTake');if(report)blocked(report);},close};
  }catch(error){await close().catch(()=>{});throw Error(error.message.startsWith('whole guard')?error.message:'whole guard unavailable');}
}

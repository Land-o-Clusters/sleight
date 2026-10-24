import { randomUUID } from 'node:crypto';
import { hookProof, hookOpen } from './page.mjs';

export async function guardWholeRead(entry, deadline, bank) {
  const {page,hook}=entry,token=randomUUID();
  if(!hook)throw Error('whole guard unavailable');
  const pending=new Set(),tasks=new Set(),requests=new Map();
  let session,children,armed=false,closed=false,bypassed=false,firstClick,protectUntil=0;
  const call=async(method,...args)=>{
    const expression=`window[${JSON.stringify(hook.key)}]?.[${JSON.stringify(method)}]?.(${[hookProof(hook,method),...args].map(value=>JSON.stringify(value)).join(',')})`;
    const reply=await session.send('Runtime.evaluate',{expression,returnByValue:true,timeout:1000});
    if(reply.exceptionDetails)throw Error('whole guard unavailable');
    return hookOpen(hook,reply.result?.value);
  };
  const blocked=kind=>{if(bank.blocked.length<100&&!bank.blocked.includes(kind))bank.blocked.push(kind);};
  const requested=request=>{if(request.method()==='GET'&&['xhr','fetch'].includes(request.resourceType()))pending.add(request);};
  const finished=request=>pending.delete(request);
  const originOf=url=>{try{return new URL(url).origin;}catch{return 'unknown origin';}};
  const held=(method,url)=>{
    const origin=originOf(url),rows=bank.held??= [],row=rows.find(row=>row.method===method&&row.origin===origin);
    if(row)row.count++;
    else if(rows.length<100)rows.push({method,origin,count:1});
    else bank.heldOverflow=(bank.heldOverflow??0)+1;
  };
  // Network's wall time identifies initiation, even if Fetch delivery is delayed.
  const initiated=event=>{
    if(requests.size>=2048)requests.delete(requests.keys().next().value);
    requests.set(event.requestId,event.wallTime*1000);
  };
  const done=event=>requests.delete(event.requestId);
  const paused=event=>{
    const native=requests.get(event.networkId),at=Number.isFinite(native)?native:Date.now();
    const method=event.request.method;
    const preflight=method==='OPTIONS'&&Object.entries(event.request.headers??{}).some(([name,value])=>name.toLowerCase()==='access-control-request-method'&&String(value).toUpperCase()==='GET');
    const task=(async()=>{
      if(method!=='GET'&&!preflight&&firstClick!==undefined&&at>=firstClick) {
        await session.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'});
        held(method,event.request.url);
        if(event.resourceType==='Document')blocked('navigation');
      } else if(event.resourceType==='Document') {
        blocked('navigation');
        await session.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:204});
      } else await session.send('Fetch.continueRequest',{requestId:event.requestId});
    })().catch(()=>{blocked('request guard unavailable');});
    tasks.add(task);task.finally(()=>tasks.delete(task));
  };
  const navigated=frame=>{if(frame===page.mainFrame())blocked('document or URL changed');};
  const dialog=()=>{blocked('dialog pending; no answer sent');};
  async function close(){
    if(closed)return;closed=true;
    let failure;
    // Hold non-GETs until Fetch is released, including hook and input cleanup.
    // Keep the existing minimum drain after a click even for a capped read.
    for(;;){const remaining=protectUntil-Date.now();if(remaining<=0)break;await new Promise(resolve=>setTimeout(resolve,remaining));}
    if(armed){try{const report=await call('wholeTake');if(report)blocked(report);if(await call('whole',token,0)!==true)throw Error('whole guard release');}catch(e){failure=e;}}
    if(session){
      await Promise.allSettled([...tasks]);
      if(children)try{await children.remove();}catch(e){failure??=e;}
      try{await session.send('Fetch.disable');}catch(e){failure??=e;}
      await Promise.allSettled([...tasks]);
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
    if(entry.guardWholeRequests)children=await entry.guardWholeRequests({after:()=>firstClick,held,failed:blocked});
    page.on('framenavigated',navigated);page.on('dialog',dialog);
    return {pending:()=>pending.size>0,
      expanderClick(){firstClick??=Date.now();protectUntil=Date.now()+2000;return ()=>{protectUntil=Math.max(protectUntil,Date.now()+2000);};},
      async poll(){const report=await call('wholeTake');if(report)blocked(report);},close};
  }catch(error){await close().catch(()=>{});throw Error(error.message.startsWith('whole guard')?error.message:'whole guard unavailable');}
}

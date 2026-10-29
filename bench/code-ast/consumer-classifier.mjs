// Classify the specific output delta. Caller spelling never grants a verdict.
import { isDeepStrictEqual as equal } from 'node:util';
import { parseCell, walk, memberCall, callInventory, handleBindings, invalidHandleNames, literalValue, UNKNOWN } from '../../plugins/sleight/lib/code-ast.mjs';
import { argumentValue, unsafeHandleUse, unsafeHandleRefusal, receiverRoot } from '../../plugins/sleight/lib/call-inspection.mjs';
import { nativeArgumentError } from '../../plugins/sleight/lib/native-arguments.mjs';
const held = () => ({verdict:'regression',reason:'unclassified output difference requires review'});
export function classify(name, code, before, after) {
  const {ast,error}=parseCell(code); if(error)return held();
  const hints=handleBindings(ast), invalid=invalidHandleNames(ast);
  const unknownCall=callInventory(ast).some(entry=>!memberCall(entry.node) || memberCall(entry.node).method===UNKNOWN);
  const unsafe=unsafeHandleUse(ast);
  if (['elements','clipboard'].includes(name) && Array.isArray(before) && unsafe && equal(after,{refused:unsafeHandleRefusal(unsafe)}))
    return {verdict:'safety correction',reason:'unsafe handle use now refuses instead of returning a misleading empty inventory'};
  if(name==='native' && before===null && typeof after==='string') {
    if(unsafe && after===unsafeHandleRefusal(unsafe)) return {verdict:'safety correction',reason:'unsafe handle use now refuses before native dispatch'};
    const native=new Set(['app', ...[...hints].filter(([,hint])=>hint.kind==='app').map(([name])=>name)]);
    for(const node of walk(ast)) {
      const call=memberCall(node);
      if(!call || call.receiver.type!=='Identifier' || !native.has(call.receiver.name) || call.args.some(arg=>arg.type==='SpreadElement')) continue;
      const problem=nativeArgumentError(call.method,call.args.map(argumentValue),UNKNOWN);
      if(problem && after===problem+'.') return {verdict:'old path wrong',reason:'opened-app binding exposes a specific malformed native argument list'};
    }
  }
  if(name!=='flow' || !before || !after || !Array.isArray(before.handles) || !Array.isArray(after.handles))return held();
  if(before.unknown!==after.unknown && !(before.unknown===false && after.unknown===true && (unknownCall||unsafe)))return held();
  const oldHandles=new Map(before.handles), newHandles=new Map(after.handles);
  const added=[...newHandles].filter(([name])=>!oldHandles.has(name));
  const removed=[...oldHandles].filter(([name])=>!newHandles.has(name));
  const changed=[...newHandles].filter(([name,value])=>oldHandles.has(name)&&!equal(value,oldHandles.get(name)));
  if(changed.length)return held();
  if(added.some(([name,value])=>!hints.get(name)?.source || !equal(value,{app:'Fixture',host:null,web:false,observed:false})))return held();
  if(removed.some(([name])=>!invalid.has(name)&&hints.has(name)))return held();
  const core=({handles,unknown,...rest})=>rest;
  if(equal(core(before),core(after))) {
    if(added.length) return {verdict:'additive',reason:'opened-app binding hints added; existing inputs and read target are identical'};
    if(removed.length) return {verdict:'safety correction',reason:'unproved or invalidated handle hints removed; existing inputs and read target are identical'};
    if(before.unknown!==after.unknown) return {verdict:'additive',reason:'indirect invocation inventory now feeds the unknown-destination rule policy'};
  }
  // A window-number acquisition proves no app name. Pin the entire remaining
  // output, allowing only the loss of the former guessed read-app name.
  const windowAcquisition=callInventory(ast).some(({node})=>{
    const call=memberCall(node),arg=call?.args[0];
    return call?.method==='getApp'&&call.receiver.type==='Identifier'&&call.receiver.name==='cua'&&arg?.type==='ObjectExpression'&&
      arg.properties.some(p=>p.type==='Property'&&!p.computed&&p.key.name==='windowId');
  });
  const noReadApp=value=>{const copy=structuredClone(core(value));delete copy.readApp;if(copy.readTarget)delete copy.readTarget.app;return copy;};
  if(windowAcquisition&&after.readApp===undefined&&after.readTarget?.app===undefined&&equal(noReadApp(before),noReadApp(after)))
    return {verdict:'safety correction',reason:'window-number acquisition clears only the guessed read-app identity'};
  const noTargets=value=>({...core(value),inputs:value.inputs.map(({target,...input})=>input)});
  const widened = callInventory(ast).flatMap(({node})=>{
    const call=memberCall(node),root=call&&receiverRoot(call.receiver);
    if(!call || !(invalid.has(root)||call.receiver.type==='Identifier'&&root!=='app'&&!hints.has(root)))return [];
    const values=call.args.map(literalValue);
    const value=call.method==='setValue'||call.method==='createBrowserTab'?values[1]
      :typeof values[0]==='string'?values[0]:values[1]??values[0];
    return typeof value==='string'?[JSON.stringify([call.method,value])]:[];
  });
  const justified = after.inputs.every((input,i)=>{
    if(equal(input.target,before.inputs[i]?.target))return true;
    if(!equal(input.target,{}))return false;
    const at=widened.indexOf(JSON.stringify([input.method,input.value]));
    if(at<0)return false;widened.splice(at,1);return true;
  });
  if(equal(noTargets(before),noTargets(after))&&before.inputs.length===after.inputs.length&&justified&&removed.every(([name])=>invalid.has(name)))
    return {verdict:'safety correction',reason:'assigned, shadowed or unbound handles widen only their destinations to unknown; literal inputs are unchanged'};
  return held();
}

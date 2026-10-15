import {bridgeStatus,proxyCompanion} from './bridge.mjs';
import {providerStatus} from './providers.mjs';

export const peerRequest=(request,pathname)=>new Request(new URL(pathname,request.url),{method:'GET',signal:request.signal});
export const bridgeOptions=options=>({...options.bridgeOptions,...(options.fetch?{fetch:options.fetch}:{})});

export async function hybridStatus(request,env={},options={}){
  const runtime=options.runtime||'cloud',providers=providerStatus(env,runtime,options.hasADC);
  if(runtime==='local')return {runtime,mode:'local',configured:true,connected:true,reason:'You are using the local workspace directly.',companion:{configured:true,connected:true,reason:'Local workspace is running.'},providers};
  const config=bridgeStatus(env,bridgeOptions(options));
  const companion={...config,host:config.endpoint?new URL(config.endpoint).hostname:undefined,connected:false};
  if(!config.configured)return {runtime,mode:'cloud-only',configured:false,connected:false,reason:config.reason,companion,providers};
  const response=await proxyCompanion(peerRequest(request,'/api/repository/status'),env,bridgeOptions(options));
  const data=await response.json();
  if(!response.ok||typeof data.configured!=='boolean')return {runtime,mode:'hybrid',configured:true,connected:false,reason:data.message||'The companion did not return a valid workspace status.',companion:{...companion,reason:data.message||'Companion verification failed.'},providers};
  const reason=data.configured?'Your hosted workspace is connected to the companion repository.':'The companion is connected. Set FORGE_WORKSPACE on that machine to open a repository.';
  return {runtime,mode:'hybrid',configured:true,connected:true,reason,repositoryConfigured:data.configured,companion:{...companion,connected:true,reason},providers:{...providers,...data.models}};
}

export async function companionCliStatus(request,env,options){
  const response=await proxyCompanion(peerRequest(request,'/api/companion/cli/status'),env,bridgeOptions(options));
  const data=await response.json();
  if(response.ok&&data.github&&data.google&&data.huggingface)return data;
  const unavailable={installed:false,authenticated:false,reason:data.message||'The companion CLI connection could not be verified.'};
  return {github:unavailable,google:unavailable,huggingface:unavailable};
}

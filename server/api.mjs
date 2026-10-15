import { AGENTS } from './agents.mjs';
import { providerStatus } from './providers.mjs';
import { executeRun } from './run.mjs';
import { appError, googleToken } from './auth.mjs';
import { testMcpConnection } from './mcp.mjs';
import { validateDatasets } from './datasets.mjs';
import {PROVIDERS,integrationCatalog,integrationStatus,integrationTest,integrationGithubRead} from './integrations.mjs';
import {startOAuth,callbackOAuth,getOAuthToken,disconnectOAuth} from './oauth.mjs';
import {bridgeStatus,proxyCompanion,isCompanionRequest} from './bridge.mjs';
import {hybridStatus,companionCliStatus,peerRequest,bridgeOptions} from './hybrid.mjs';
import {discoverOpenAIModels} from './openai.mjs';
const active=new Set();
const completed=new Map();
export const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
async function body(request) {
  if(!request.headers.get('content-type')?.includes('application/json')) throw appError('Send JSON requests.',415);
  if(Number(request.headers.get('content-length')||0)>500000) throw appError('Request too large.',413);
  const reader=request.body?.getReader(); if(!reader)throw appError('Missing request body.');
  let size=0,text=''; const decoder=new TextDecoder();
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>500000){await reader.cancel();throw appError('Request too large.',413);}text+=decoder.decode(value,{stream:true});}
  try {return JSON.parse(text+decoder.decode());}catch {throw appError('Invalid JSON request.');}
}
function customMcpConfig(env) {
  try {const list=JSON.parse(env.MCP_SERVERS_JSON||'[]');return Array.isArray(list)?list:[];}catch{return [];}
}
async function visitorCredentials(request,env,options){
  const scoped={...env},oauthConnected=new Set();
  if(env.OAUTH_SESSION_SECRET)for(const [id,key] of [['aweber','AWEBER_MCP_TOKEN'],['getresponse','GETRESPONSE_MCP_TOKEN'],['sandcastles','SANDCASTLES_MCP_TOKEN']]){
    const provider=PROVIDERS.find(item=>item.id===id);
    if(provider.endpointEnv&&env[provider.endpointEnv]){try{if(new URL(env[provider.endpointEnv]).href!==new URL(provider.endpoint).href)continue;}catch{continue;}}
    const token=await getOAuthToken(id,request,env);
    if(token){scoped[key]=token;oauthConnected.add(id);}
  }
  return {env:scoped,options:{...options,oauthConnected,signal:request.signal}};
}
export async function handleApi(request,env={},options={}) {
  const url=new URL(request.url); const runtime=options.runtime||'cloud';
  try {
    const hybrid=runtime==='cloud'&&bridgeStatus(env,bridgeOptions(options)).configured;
    if(request.method==='POST'){
      const origin=request.headers.get('origin');
      if(origin&&origin!==url.origin)throw appError('Cross-origin requests are not allowed.',403,'ORIGIN_BLOCKED');
      if(request.headers.get('sec-fetch-site')==='cross-site')throw appError('Cross-site requests are not allowed.',403,'ORIGIN_BLOCKED');
    }
    if(['/api/provider/models','/api/provider/models/hosted','/api/usage'].includes(url.pathname)&&request.method!=='GET')throw appError('Use GET for model catalogs and usage records.',405,'METHOD_NOT_ALLOWED');
    if(request.method==='GET'&&url.pathname==='/api/hybrid/status')return json(await hybridStatus(request,env,options));
    const oauthCallback=url.pathname.match(/^\/api\/integrations\/oauth\/callback\/([a-z-]+)$/);
    if(oauthCallback)return await callbackOAuth(oauthCallback[1],request,env,{fetch:options.fetch});
    if(request.method==='GET'&&url.pathname==='/api/integrations/status')return json(await integrationStatus(env,{...options,...(hybrid?{runtime:'hybrid',cliStatus:()=>companionCliStatus(request,env,options)}:{}),signal:request.signal}));
    if(request.method==='GET'&&url.pathname==='/api/integrations/catalog'){
      const scoped=await visitorCredentials(request,env,options);return json(integrationCatalog(scoped.env,scoped.options));
    }
    if(request.method==='GET'&&url.pathname==='/api/status') {
      const providers=providerStatus(env,runtime,options.hasADC);
      if(options.providerHealth)Object.assign(providers,await options.providerHealth());
      const quickTaskProviders={...providers};let connected=false;
      if(hybrid){const response=await proxyCompanion(peerRequest(request,'/api/status'),env,bridgeOptions(options));if(response.ok){const peer=await response.json();if(peer.providers){Object.assign(providers,peer.providers);connected=true;}}}
      return json({version:'1.4.1',runtime:connected?'hybrid':runtime,providers,quickTaskProviders,hybrid:{configured:hybrid,connected},mcp:{supported:true,allowedHosts:['aiplatform.googleapis.com',...(env.MCP_ALLOWED_HOSTS||'').split(',').map(s=>s.trim()).filter(Boolean)],googleEndpoint:'https://aiplatform.googleapis.com/mcp/generate'},limits:{agents:50,concurrency:8,files:80,contextCharacters:300000},execution:{shell:runtime==='local',autoApply:false,sandboxRequired:true}});
    }
    if(request.method==='GET'&&url.pathname==='/api/agents') return json({agents:AGENTS});
    if(request.method==='GET'&&(url.pathname==='/api/provider/models/hosted'||url.pathname==='/api/provider/models'&&!hybrid&&runtime==='cloud'))return json({...(runtime==='local'&&options.providerHealth?await options.providerHealth():{}),openai:await discoverOpenAIModels(env,{...options,signal:request.signal})});
    if(request.method==='GET'&&hybrid&&isCompanionRequest('GET',url.pathname)){
      const response=await proxyCompanion(request,env,bridgeOptions(options));
      if(['/api/repository/status','/api/usage'].includes(url.pathname)&&response.ok)return json({...await response.json(),runtime:'hybrid'});
      return response;
    }
    if(request.method==='GET'&&runtime==='local'&&options.localHandler)return await options.localHandler(url.pathname,null,request);
    if(request.method==='GET'&&url.pathname==='/api/repository/status')return json({configured:false,runtime:'cloud',reason:'The online workspace cannot open your local filesystem. Download and run the local app with FORGE_WORKSPACE set to your repository.',downloadUrl:'/download/source.zip',sandbox:{available:false,reason:'Local companion required.'}});
    if(request.method==='GET'&&url.pathname==='/api/coding/runs')return json({runs:[],runtime:'cloud',reason:'Repository runs are stored by the local companion.'});
    if(request.method==='GET'&&url.pathname==='/api/usage')return json({runtime:'cloud',repository:null,reason:'Connect the local companion to read its saved repository task usage. Quick-task history stays in this browser.'});
    if(request.method!=='POST') return json({error:'NOT_FOUND',message:'API endpoint not found.'},404);
    if(hybrid&&isCompanionRequest(request.method,url.pathname))return await proxyCompanion(request,env,bridgeOptions(options));
    const input=await body(request);
    if(url.pathname==='/api/hybrid/test'){
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw appError('Send an empty JSON object to check the hybrid connection.');
      return json(await hybridStatus(request,env,options));
    }
    if(url.pathname==='/api/integrations/oauth/start'||url.pathname==='/api/integrations/oauth/disconnect'){
      if(!input||Object.keys(input).some(key=>key!=='providerId')||typeof input.providerId!=='string')throw appError('Choose an OAuth provider.');
      return url.pathname.endsWith('/start')?await startOAuth(input.providerId,request,env,{fetch:options.fetch}):await disconnectOAuth(input.providerId,request,env);
    }
    if(url.pathname==='/api/integrations/github/read')return json(await integrationGithubRead(input,env,{...options,signal:request.signal}));
    if(url.pathname==='/api/integrations/mcp/test'){
      const scoped=await visitorCredentials(request,env,options);return json(await integrationTest(input,scoped.env,scoped.options));
    }
    if(url.pathname==='/api/integrations/cli/run'){
      if(runtime!=='local'||typeof options.cliRun!=='function')throw appError('CLI profiles run in the local companion. Open the local app on the machine with your CLI installations.',503,'LOCAL_RUNTIME_REQUIRED');
      return json(await options.cliRun(input));
    }
    if(url.pathname==='/api/datasets/validate') return json(validateDatasets(input));
    if(url.pathname==='/api/run') {
      const key=request.headers.get('Idempotency-Key');
      if(key&&(key.length>100||!/^[a-zA-Z0-9-]+$/.test(key)))throw appError('Invalid request key.');
      const fingerprint=JSON.stringify(input);
      if(key&&completed.has(key)){const entry=completed.get(key);if(entry.fingerprint!==fingerprint)throw appError('Request key already used for a different task.',409);return json(entry.result);}
      if(key&&active.has(key))throw appError('This task is already running. Wait for its result.',409,'ALREADY_RUNNING');
      if(active.size>=2)throw appError('Two task runs are already active. Wait for a run to finish.',429,'RUN_LIMIT');
      const runKey=key||crypto.randomUUID();active.add(runKey);
      const controller=new AbortController();
      const signal=AbortSignal.any([request.signal,controller.signal,AbortSignal.timeout(600000)]);
      try {
        const result=await executeRun(input,env,{...options,runtime,signal});
        if(key){if(completed.size>=30)completed.delete(completed.keys().next().value);completed.set(key,{fingerprint,result});}
        return json(result);
      } finally {controller.abort();active.delete(runKey);}
    }
    if(url.pathname==='/api/mcp/test') {
      if(typeof input.url!=='string')throw appError('Enter an MCP server URL.');
      const allowedHosts=['aiplatform.googleapis.com',...(env.MCP_ALLOWED_HOSTS||'').split(',').map(s=>s.trim()).filter(Boolean)];
      let token;
      let target;try {target=new URL(input.url);}catch{throw appError('Enter a valid MCP URL.');}
      if(target.hostname==='aiplatform.googleapis.com'&&(env.GOOGLE_ACCESS_TOKEN||env.GOOGLE_SERVICE_ACCOUNT_JSON||options.hasADC)) token=await googleToken(env,options);
      const server=customMcpConfig(env).find(s=>s.url===target.href);
      if(server?.tokenEnv&&/^[A-Z][A-Z0-9_]+$/.test(server.tokenEnv))token=env[server.tokenEnv];
      const result=await testMcpConnection({url:input.url,token},{allowedHosts,fetch:options.fetch});
      return json({...result,executionAuthorized:false,note:'Tool discovery succeeded. Executing tools may require additional authentication and permissions.'});
    }
    if(runtime==='local'&&options.localHandler) return await options.localHandler(url.pathname,input,request);
    return json({error:'NOT_FOUND',message:'API endpoint not found.'},404);
  }catch(error) {
    if(error.name==='AbortError'||error.name==='TimeoutError')return json({error:'CANCELLED',message:'The task was cancelled or reached its time limit. Completed provider calls may still be billed.'},408);
    if(error.status)return json({error:error.code||'REQUEST_FAILED',message:error.message},error.status);
    // Provider content, tokens and server paths are intentionally excluded from failures.
    return json({error:'REQUEST_FAILED',message:'The request could not complete. Check provider setup and connectivity, then try again.'},502);
  }
}

import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRepositoryService} from './repository.mjs';
import {createSandboxRunner} from './sandbox.mjs';
import {executeCodingTask} from './coding.mjs';
import {createRunStore} from './run-store.mjs';
import {generate as defaultGenerate,providerStatus} from './providers.mjs';
import {discoverOpenAIModels} from './openai.mjs';
import {summarizeUsage} from './usage.mjs';
import {appError} from './auth.mjs';
import {createCliService} from './cli.mjs';
const now=()=>new Date().toISOString();
const activeStates=new Set(['queued','running']);
const digest=value=>createHash('sha256').update(value).digest('hex');
function compactEvent(event){const copy={...event};if(copy.result&&Buffer.byteLength(JSON.stringify(copy.result))>16000)copy.result={truncated:true,preview:JSON.stringify(copy.result).slice(0,12000)};return copy;}
export async function createLocalServices({env=process.env,appRoot,repository,runner,store,generate=defaultGenerate,tokenProvider}={}){
  const cli=createCliService({env,workspace:appRoot});
  const repo=repository||(env.FORGE_WORKSPACE?createRepositoryService(path.resolve(env.FORGE_WORKSPACE)):null);
  const sandbox=runner||createSandboxRunner({image:{node:env.FORGE_NODE_IMAGE||'easy-agent-runner:local',python:env.FORGE_PYTHON_IMAGE||'dazza-forge-eval:local'},timeoutMs:30000});
  const records=store||createRunStore(env.FORGE_STATE_DIR||path.join(appRoot,'.forge','coding-runs'));
  await records.recover();
  const jobs=new Map(),manualJobs=new Set();const applyLocks=new Set();let healthCache,startingRuns=0;let admission=Promise.resolve();
  const reserve=()=>{if(jobs.size+manualJobs.size+startingRuns>=2)throw appError('Two tasks are already active. Wait or cancel one.',429,'RUN_LIMIT');};
  const requireRepo=()=>{if(!repo)throw appError('Set FORGE_WORKSPACE to an existing repository directory and restart the local app.',503,'WORKSPACE_REQUIRED');return repo;};
  async function health(){
    if(healthCache&&healthCache.expires>Date.now())return healthCache.value;
    let local;
    try{
      const base=new URL(env.OLLAMA_BASE_URL||'http://127.0.0.1:11434');
      if(!['http:','https:'].includes(base.protocol)||base.username||base.password)throw new Error();
      const response=await fetch(new URL('/api/tags',base),{redirect:'error',signal:AbortSignal.timeout(2500)});
      if(!response.ok)throw new Error();const data=await response.json();
      const models=Array.isArray(data.models)?data.models.map(m=>m.name).filter(n=>typeof n==='string').slice(0,100):[];
      local={configured:models.length>0,reachable:true,models,model:env.OLLAMA_MODEL||'qwen2.5-coder:7b',reason:models.length?'Ollama is reachable; choose an installed model.':'Ollama is reachable but has no installed models.'};
    }catch{local={configured:false,reachable:false,models:[],model:env.OLLAMA_MODEL||'qwen2.5-coder:7b',reason:'Ollama is unavailable. Start it and install a model on the local server.'};}
    healthCache={expires:Date.now()+5000,value:{local}};return healthCache.value;
  }
  async function status(){
    let info=null,reason;
    if(repo){try{info=await repo.info();}catch(error){reason=error.message;}}
    else reason='Download the local app and set FORGE_WORKSPACE to your repository directory.';
    return {configured:!!info,runtime:'local',repository:info,...(reason?{reason}:{}),sandbox:await sandbox.status(),models:{...providerStatus(env,'local',!!tokenProvider),...await health()},limits:{snapshotFiles:100,snapshotBytes:500000,maxSteps:30,maxActiveRuns:2}};
  }
  async function startUnlocked(input,request){
    requireRepo();
    if(typeof input?.task!=='string'||input.task.trim().length<3||input.task.length>16000)throw appError('Describe your coding task in 3–16,000 characters.');
    if(!['local','vertex','openai'].includes(input.provider))throw appError('Choose OpenAI, Vertex AI, or local Ollama.');
    const requestKey=request?.headers.get('Idempotency-Key');
    if(requestKey&&(requestKey.length>100||!/^[a-zA-Z0-9-]+$/.test(requestKey)))throw appError('Invalid request key.');
    const fingerprint=digest(JSON.stringify(input));
    if(requestKey){const existing=(await records.list()).find(record=>record.requestKey===requestKey);if(existing){if(existing.fingerprint!==fingerprint)throw appError('Request key belongs to another task.',409);return {statusCode:202,data:{id:existing.id,status:existing.status}};}}
    reserve();startingRuns++;
    try{
    const info=await repo.info();
    const snapshot=await repo.snapshot();
    if(snapshot.truncated)throw appError('Repository exceeds the 100-file or 500,000-byte task snapshot limit. Select a smaller source directory.',413,'CONTEXT_LIMIT');
    const id=randomUUID(),createdAt=now();
    await records.save({id,status:'queued',task:input.task.trim(),provider:input.provider,model:input.model,createdAt,updatedAt:createdAt,events:[],proposals:[],tests:[],appliedPaths:[],repository:info,...(requestKey?{requestKey,fingerprint}:{})});
    const controller=new AbortController();
    const job={controller,promise:null};jobs.set(id,job);
    job.promise=(async()=>{
      try{
        await records.update(id,{status:'running'});
        const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(15*60*1000)]);
        const result=await executeCodingTask(input,{repository:{...repo,snapshot:async()=>snapshot},runner:sandbox,generate:(params,providerEnv,options)=>generate(params,providerEnv,{...options,...(tokenProvider?{tokenProvider}:{})}),env,signal,onEvent:event=>records.update(id,record=>({...record,events:[...(record.events||[]),compactEvent(event)].slice(-250)}))});
        const before=new Map(snapshot.files.map(file=>[file.path,file.content]));
        const proposals=(result.proposals||[]).map(change=>({...change,beforeContent:before.get(change.path)??null}));
        await records.update(id,record=>({...record,...result,id,events:(result.events||[]).map(compactEvent),proposals,changes:proposals,appliedPaths:[],finishedAt:now()}));
      }catch(error){await records.update(id,{status:controller.signal.aborted?'cancelled':'failed',error:{code:error.code||'RUN_FAILED',message:error.status?error.message:'The coding task could not complete. Check local providers and repository configuration.'},finishedAt:now()}).catch(()=>{});}
      finally{jobs.delete(id);}
    })();
    return {statusCode:202,data:{id,status:'queued'}};
    }finally{startingRuns--;}
  }
  async function start(input,request){const previous=admission;let release;admission=new Promise(resolve=>{release=resolve;});await previous;try{return await startUnlocked(input,request);}finally{release();}}
  async function manualTest(command,request){
    requireRepo();reserve();
    const controller=new AbortController(),job={controller,promise:null};manualJobs.add(job);
    job.promise=(async()=>{const snapshot=await repo.snapshot();if(snapshot.truncated)throw appError('The repository exceeds the sandbox snapshot limits.',413,'CONTEXT_LIMIT');return sandbox.run({files:snapshot.files,command,signal:request?.signal?AbortSignal.any([request.signal,controller.signal]):controller.signal});})();
    try{return await job.promise;}finally{manualJobs.delete(job);}
  }
  async function route(endpoint,input,request){
    const method=request?.method||'POST';
    if(['/api/provider/models','/api/usage'].includes(endpoint)&&method!=='GET')throw appError('Use GET for model catalogs and usage records.',405,'METHOD_NOT_ALLOWED');
    const readOnly=['/api/repository/status','/api/provider/models','/api/coding/runs','/api/usage'].includes(endpoint)||/^\/api\/coding\/runs\/[a-f0-9-]{36}$/.test(endpoint);
    if(method!=='POST'&&!(method==='GET'&&readOnly))throw appError('Use POST for repository actions.',405,'METHOD_NOT_ALLOWED');
    if(endpoint==='/api/repository/status')return {data:await status()};
    if(endpoint==='/api/provider/models')return {data:{...await health(),openai:await discoverOpenAIModels(env,{signal:request?.signal})}};
    if(endpoint==='/api/usage')return {data:{runtime:'local',repository:summarizeUsage(await records.list(),{scope:'repository'})}};
    if(endpoint==='/api/coding/runs')return {data:{runs:await records.list()}};
    const match=endpoint.match(/^\/api\/coding\/runs\/([a-f0-9-]{36})(?:\/(cancel|apply))?$/);
    if(match){
      const [,,action]=match;const id=match[1];
      if(!action)return {data:await records.get(id)};
      if(action==='cancel'){
        const record=await records.get(id);const job=jobs.get(id);if(job)job.controller.abort();
        return {data:{id,status:job?'cancelling':record.status}};
      }
      if(applyLocks.has(id))throw appError('These proposals are already being applied.',409);
      applyLocks.add(id);
      try{
        const record=await records.get(id);if(activeStates.has(record.status))throw appError('Wait until the task stops before applying proposals.',409);
        if(!Array.isArray(input?.paths)||!input.paths.length||new Set(input.paths).size!==input.paths.length)throw appError('Select unique proposed file paths.');
        const current=await requireRepo().info();if(current.root!==record.repository?.root)throw appError('This run belongs to another repository.',409,'REPOSITORY_CHANGED');
        const selected=input.paths.map(name=>(record.proposals||[]).find(p=>p.path===name));
        if(selected.some((proposal,index)=>!proposal||(record.appliedPaths||[]).includes(input.paths[index])))throw appError('One or more proposals are missing or already applied.',409);
        const result=await repo.applyChanges({changes:selected.map(p=>({path:p.path,content:p.content,baseHash:p.baseHash,...(p.operation==='delete'?{delete:true}:{})}))});
        await records.update(id,record=>({...record,appliedPaths:[...(record.appliedPaths||[]),...input.paths],appliedAt:now()}));
        return {data:{...result,run:await records.get(id)}};
      }finally{applyLocks.delete(id);}
    }
    if(endpoint==='/api/coding/start')return start(input,request);
    if(endpoint==='/api/repository/tree')return {data:await requireRepo().tree()};
    if(endpoint==='/api/repository/read')return {data:await requireRepo().readFile(input?.path)};
    if(endpoint==='/api/repository/search')return {data:await requireRepo().search(input?.query)};
    if(endpoint==='/api/repository/apply')return {data:await requireRepo().applyChanges(input)};
    if(endpoint==='/api/repository/git/status')return {data:await requireRepo().gitStatus()};
    if(endpoint==='/api/repository/git/diff'){const diff=await requireRepo().gitDiff();return {data:typeof diff==='string'?{diff}:diff};}
    if(endpoint==='/api/repository/git/branch')return {data:await requireRepo().createBranch(input?.name)};
    if(endpoint==='/api/repository/git/commit'){const result=await requireRepo().commit(input);return {data:{...result,commit:result.sha||result.head}};}
    if(endpoint==='/api/repository/test'){
      return {data:await manualTest(input?.command,request)};
    }
    if(endpoint==='/api/terminal'){
      const commands={'npm test':'npm:test','npm run build':'npm:build'};
      if(commands[input?.command]){const result=await manualTest(commands[input.command],request);return {data:{...result,message:result.status==='infrastructure_error'?'An isolated test runner is required.':undefined}};}
      if(input?.command==='pwd')return {data:{output:(await requireRepo().info()).root,exitCode:0}};
      if(input?.command==='ls')return {data:{output:(await requireRepo().tree()).files.map(f=>f.path).join('\n'),exitCode:0}};
      if(input?.command==='git status')return {data:{output:JSON.stringify(await requireRepo().gitStatus(),null,2),exitCode:0}};
      if(input?.command==='git log'){const info=await requireRepo().info();return {data:{output:`Branch: ${info.branch||'(none)'}\nHEAD: ${info.head||'(no commit)'}`,exitCode:0}};}
      throw appError('Choose a supported local terminal profile.');
    }
    throw appError('API endpoint not found.',404,'NOT_FOUND');
  }
  async function stop(){const active=[...jobs.values(),...manualJobs];for(const job of active)job.controller.abort();await Promise.allSettled(active.map(job=>job.promise));}
  return {route,status,health,stop,store:records,cliStatus:()=>cli.status(),cliRun:input=>cli.run(input)};
}

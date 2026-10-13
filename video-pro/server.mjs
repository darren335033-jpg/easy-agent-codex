import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {JobStore} from './lib/jobs.mjs';
import {createProviders,publicProviderStatus} from './lib/providers.mjs';
import {createRunwayProviders} from './lib/runway.mjs';
import {createAuth} from './lib/auth.mjs';
import {createBilling} from './lib/billing.mjs';
import {streamVideo} from './lib/media.mjs';
import {BillingLedger} from './lib/billing-ledger.mjs';
import {createRegistry} from './lib/agents.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const fail=(status,message)=>Object.assign(new Error(message),{status});
const load=async name=>JSON.parse(await readFile(join(root,'config',name),'utf8'));
export async function createApp({env=process.env,dataPath=join(root,'.data','jobs.json'),providers,fetchImpl=fetch}={}){
 const [registry,plans,campaigns]=await Promise.all([createRegistry(join(root,'config','agent-blueprint.json')),load('plans.json'),load('campaigns.json')]);
 const auth=createAuth(env,fetchImpl),billing=await createBilling(env,plans);
 const liveEnabled=env.VIDEO_LIVE_ENABLED==='true';
 const providerMap=providers??{...createProviders(env,{fetchImpl}),...createRunwayProviders(env,{fetchImpl})};
 const jobs=await new JobStore({filePath:dataPath,providers:providerMap,liveEnabled}).init();
 const publicJob=job=>{const {videoUrl,operationId,...visible}=job;return {...visible,hasVideo:Boolean(videoUrl),mediaPath:videoUrl?`/api/jobs/${job.id}/video`:null}};
 const ledger=new BillingLedger({filePath:join(dirname(dataPath),'billing.sqlite')});
 const csrf=randomBytes(32).toString('hex'),limits=new Map();
 const summary={total:registry.agents.length,active:0,pilotCount:registry.pilotAgentIds.length};
 const publicFiles={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/styles.css':'styles.css'};
 function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
 async function rawBody(req){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>65536)throw fail(413,'Request body too large.');chunks.push(chunk)}return Buffer.concat(chunks);}
 async function body(req){if(!req.headers['content-type']?.startsWith('application/json'))throw fail(415,'Use application/json.');try{return JSON.parse((await rawBody(req)).toString('utf8'))}catch(e){if(e.status)throw e;throw fail(400,'Invalid JSON.');}}
 const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' https://*.googleapis.com https://*.runwayml.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try{
   const host=req.headers.host,port=server.address()?.port;
   if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host))throw fail(403,'Invalid local host.');
   const origin=`http://${host}`;
   if(req.headers.origin&&req.headers.origin!==origin)throw fail(403,'Cross-origin requests are not allowed.');
   if(req.headers['sec-fetch-site']==='cross-site')throw fail(403,'Cross-site requests are not allowed.');
   const url=new URL(req.url,origin),path=url.pathname;
   const addr=req.socket.remoteAddress;let rate=limits.get(addr);if(!rate||Date.now()-rate.started>60000){rate={started:Date.now(),count:0};limits.set(addr,rate)}
   if(path.startsWith('/api/')&&++rate.count>120)throw fail(429,'Rate limit reached. Try again shortly.');
   if(path==='/api/health'&&req.method==='GET')return json(res,200,{ok:true,version:'3.1.0'});
   if(path.startsWith('/api/')){
    if(path==='/api/auth/config'&&req.method==='GET')return json(res,200,{mode:auth.mode,csrfToken:csrf});
    if(path==='/api/billing/webhook'&&req.method==='POST'){const event=billing.verifyWebhook(await rawBody(req),req.headers['stripe-signature']);return json(res,200,ledger.process(event,{allowedPlanIds:plans.plans.map(p=>p.id)}));}
    let user;if(!['/api/auth/login','/api/auth/logout'].includes(path))user=await auth.verify(req);
    if(req.method!=='GET'&&req.method!=='HEAD'){
     const token=req.headers['x-csrf-token'];if(typeof token!=='string'||token.length!==csrf.length||!timingSafeEqual(Buffer.from(token),Buffer.from(csrf)))throw fail(403,'Missing or invalid CSRF token.');
    }
    if(path==='/api/auth/login'&&req.method==='POST'){const data=await body(req);const session=await auth.login(data.email,data.password);res.setHeader('Set-Cookie',`video_session=${session.sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${session.maxAge}`);return json(res,200,{ok:true});}
    if(path==='/api/auth/logout'&&req.method==='POST'){await auth.logout(req);res.setHeader('Set-Cookie','video_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json(res,200,{ok:true});}
    if(path==='/api/entitlement'&&req.method==='GET')return json(res,200,ledger.getEntitlement(user.id));
    if(path==='/api/status'&&req.method==='GET')return json(res,200,{mode:liveEnabled&&Object.keys(providerMap).length?'live':'planning',csrfToken:csrf,authMode:auth.mode,providers:publicProviderStatus(env).map(p=>({...p,status:['runway','seedance'].includes(p.id)&&env.RUNWAY_API_KEY?'credentials_present':p.status,name:{veo:'Google Veo 3.1',runway:'Runway Gen-4.5',seedance:'Seedance 2.0',local:'ComfyUI / Wan / LTX'}[p.id],detail:p.id==='local'?'Local workflow adapter pending.':'Text-to-video adapter implemented; live credentials, access and media host unverified.'})),agents:summary,integrations:[{name:'Stripe',status:billing.enabled?'configured_unverified':'disabled',detail:'Draft pricing; no checkout until costs and webhook delivery are verified.'},{name:'Supabase',status:auth.mode==='supabase'?'configured_unverified':'unconfigured',detail:auth.mode==='supabase'?'Server-side verified-owner login. Cloud database and media storage are not connected.':'Local storage only; no cloud database connected.'},{name:'Firecrawl',status:'not_connected',detail:'No Firecrawl tools are available in this session; research integration is pending.'},{name:'ElevenLabs',status:'not_implemented',detail:'Voiceover adapter pending account and implementation.'},{name:'FFmpeg / DaVinci Resolve',status:'manual_workflow',detail:'Encoding and final colour/audio require external tooling.'}]});
    if(path==='/api/jobs'&&req.method==='GET')return json(res,200,{jobs:jobs.list().map(publicJob)});
    if(path==='/api/jobs'&&req.method==='POST'){const input=await body(req);if(input?.mode==='live'&&billing.enabled&&!ledger.getEntitlement(user.id).active)throw fail(402,'An active subscription is required.');return json(res,201,{job:publicJob(await jobs.create(input,{idempotencyKey:req.headers['idempotency-key']}))});}
    const match=path.match(/^\/api\/jobs\/([a-f0-9-]{36})(?:\/(cancel|refresh|video))?$/);
    if(match){if(req.method==='GET'&&match[2]==='video')return await streamVideo(jobs.get(match[1]),req,res,{env,fetchImpl});if(req.method==='GET'&&!match[2])return json(res,200,{job:publicJob(jobs.get(match[1]))});if(req.method==='POST'&&match[2]==='cancel')return json(res,200,{job:publicJob(await jobs.cancel(match[1]))});if(req.method==='POST'&&match[2]==='refresh')return json(res,200,{job:publicJob(await jobs.refresh(match[1]))});}
    if(path==='/api/plans'&&req.method==='GET')return json(res,200,{...plans,plans:plans.plans.map(p=>({...p,priceLabel:`US$${p.monthlyPriceUsd} / month · proposed`}))});
    if(path==='/api/agents'&&req.method==='GET')return json(res,200,{agents:registry.agents,summary});
    if(path==='/api/campaigns'&&req.method==='GET')return json(res,200,campaigns);
    if(path==='/api/checkout'&&req.method==='POST')return json(res,200,await billing.checkout((await body(req)).planId,origin,user.id));
    throw fail(404,'API route not found.');
   }
   if(!publicFiles[path]||req.method!=='GET')throw fail(404,'Page not found.');
   const content=await readFile(join(root,'public',publicFiles[path]));res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');res.end(content);
  }catch(error){if(res.headersSent||res.destroyed){res.destroy();return}json(res,error.status??500,{error:error.status?error.message:'Internal request failure.',...(error.jobId?{jobId:error.jobId}:{})});}
 });
 server.on('close',()=>ledger.close());
 return {server,jobs,summary};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 const port=Number(process.env.VIDEO_PORT??18806);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid VIDEO_PORT.');
 const {server}=await createApp();server.listen(port,'127.0.0.1',()=>console.log(`Easy Agent Video Pro 3.1: http://127.0.0.1:${port} (local workspace)`));
}

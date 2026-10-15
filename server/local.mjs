import http from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { handleApi, json } from './api.mjs';
import { appError } from './auth.mjs';
import { createLocalServices } from './local-service.mjs';
import { ensureOAuthSecret } from './local-config.mjs';
const exec=promisify(execFile);
const root=path.resolve(import.meta.dirname,'..');
try {process.loadEnvFile(path.join(root,'.env'));}catch(error){if(error.code!=='ENOENT')throw error;}
await ensureOAuthSecret({env:process.env,appRoot:root});
const port=Number(process.env.PORT||3000);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('PORT must be between 1024 and 65535.');
let hasADC=false;
try{await access(process.env.GOOGLE_APPLICATION_CREDENTIALS||path.join(os.homedir(),'.config/gcloud/application_default_credentials.json'),constants.R_OK);hasADC=true;}catch{}
async function tokenProvider(){
  try {const {stdout}=await exec('gcloud',['auth','application-default','print-access-token'],{timeout:15000,maxBuffer:16384});return stdout.trim();}
  catch {throw appError('Google ADC is unavailable. Install gcloud and run gcloud auth application-default login, or configure a server service account.',503,'PROVIDER_NOT_CONFIGURED');}
}
const services=await createLocalServices({env:process.env,appRoot:root,tokenProvider:hasADC?tokenProvider:undefined});
async function localHandler(endpoint,input,request) {
  const response=await services.route(endpoint,input,request);
  return json(response.data,response.statusCode||200);
}
const server=http.createServer(async(req,res)=>{
  const host=req.headers.host||'';
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host)){res.writeHead(403);res.end('Local host required.');return;}
  const url=new URL(req.url,`http://${host}`);
  try{
    if(url.pathname.startsWith('/assets/')&&req.method==='GET'){
      const name=url.pathname.slice('/assets/'.length);
      const assets={'founder-portrait.jpg':'image/jpeg','founder-brand-reference.jpg':'image/jpeg','media-thumbnail.jpg':'image/jpeg','mascot-studio.mp4':'video/mp4'};
      if(!Object.hasOwn(assets,name)){res.writeHead(404);res.end('Asset not found');return;}
      const content=await readFile(path.join(root,'assets',name));res.writeHead(200,{'Content-Type':assets[name],'Cache-Control':'private, max-age=86400','X-Content-Type-Options':'nosniff'});res.end(content);
    }else if(url.pathname==='/download/source.zip'&&req.method==='GET'){
      const archive=await readFile(path.join(root,'.forge/source.zip'));res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="dazza-forge.zip"','Cache-Control':'no-store'});res.end(archive);
    }else if(url.pathname.startsWith('/api/')){
      const abort=new AbortController();req.on('aborted',()=>abort.abort());res.on('close',()=>{if(!res.writableEnded)abort.abort();});
      const request=new Request(url,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:ReadableStream.from(req),duplex:'half',signal:abort.signal});
      const response=await handleApi(request,process.env,{runtime:'local',hasADC,tokenProvider:hasADC?tokenProvider:undefined,localHandler,providerHealth:services.health,cliStatus:services.cliStatus,cliRun:services.cliRun});
      const responseHeaders=Object.fromEntries([...response.headers].filter(([name])=>name!=='set-cookie'));
      const cookies=response.headers.getSetCookie();if(cookies.length)responseHeaders['Set-Cookie']=cookies;
      res.writeHead(response.status,responseHeaders);res.end(Buffer.from(await response.arrayBuffer()));
    }else{
      const html=await readFile(path.join(root,'.forge/index.html'));
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:html);
    }
  }catch{res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'SERVER_ERROR',message:'Request failed. Build the app before starting the companion.'}));}
});
server.listen(port,'127.0.0.1',()=>console.log(`Easy Agent AI local workspace: http://127.0.0.1:${port}`));
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(stopping)return;stopping=true;server.close();await services.stop();process.exit(0);});

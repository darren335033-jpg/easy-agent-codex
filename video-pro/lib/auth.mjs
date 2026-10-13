import {randomBytes} from 'node:crypto';
const fail=(status,message)=>Object.assign(new Error(message),{status});
export function createAuth(env,fetchImpl=fetch){
 const {SUPABASE_URL:url,SUPABASE_PUBLISHABLE_KEY:key,SUPABASE_OWNER_IDS:ids}=env;
 if(!url&&!key&&!ids)return {mode:'local',verify:async()=>({id:'local-owner'}),login:async()=>{throw fail(409,'Local mode does not require sign-in.')},logout:async()=>{}};
 if(!url||!key||!ids)throw Error('Incomplete Supabase identity configuration.');
 const parsed=new URL(url);if(parsed.protocol!=='https:'||!parsed.hostname.endsWith('.supabase.co')||parsed.pathname!=='/'||parsed.search||parsed.username||parsed.password)throw Error('Supabase URL must be a project HTTPS origin.');
 if(!key.startsWith('sb_publishable_'))throw Error('Use a Supabase publishable key for identity.');
 const owners=ids.split(',').map(x=>x.trim()).filter(Boolean);if(!owners.length)throw Error('Owner UUID allowlist is required.');
 const sessions=new Map();
 async function call(path,options){let response;try{response=await fetchImpl(`${parsed.origin}/auth/v1/${path}`,{...options,headers:{apikey:key,...options.headers},signal:AbortSignal.timeout(10000),redirect:'error'})}catch{throw fail(503,'Identity verification unavailable.');}if(response.status===400||response.status===401||response.status===403)throw fail(401,'Sign-in or session is invalid.');if(!response.ok)throw fail(503,'Identity verification unavailable.');return response;}
 async function owner(token){let user;try{user=await (await call('user',{headers:{Authorization:`Bearer ${token}`}})).json()}catch(error){if(error.status)throw error;throw fail(503,'Identity verification unavailable.');}if(!user.id||!owners.includes(user.id)||!user.email_confirmed_at)throw fail(403,'Verified owner access required.');return {id:user.id};}
 function cookie(req){return req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('video_session='))?.slice('video_session='.length)}
 return {mode:'supabase',async verify(req){
  let token=req.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
  if(!token){const sid=cookie(req),session=sessions.get(sid);if(session&&session.expires>Date.now())token=session.token;else if(sid)sessions.delete(sid);}
  if(!token)throw fail(401,'Sign in to access this local workspace.');return owner(token);
 },async login(email,password){
  if(typeof email!=='string'||!email.includes('@')||email.length>254||typeof password!=='string'||password.length<1||password.length>1024)throw fail(400,'Provide a valid email and password.');
  for(const [id,s] of sessions)if(s.expires<Date.now())sessions.delete(id);
  if(sessions.size>=100)throw fail(429,'Local session capacity reached.');
  let data;try{data=await (await call('token?grant_type=password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})})).json()}catch(error){if(error.status)throw error;throw fail(503,'Identity verification unavailable.');}
  if(typeof data.access_token!=='string'||!data.access_token)throw fail(503,'Identity verification unavailable.');
  await owner(data.access_token);const sessionId=randomBytes(32).toString('hex'),seconds=Math.max(1,Math.min(Number(data.expires_in)||3600,3600));
  sessions.set(sessionId,{token:data.access_token,expires:Date.now()+seconds*1000});return {sessionId,maxAge:seconds};
 },async logout(req){const sid=cookie(req),session=sessions.get(sid);sessions.delete(sid);if(session){try{await call('logout',{method:'POST',headers:{Authorization:`Bearer ${session.token}`}})}catch{/* local logout always removes the session */}}}};
}

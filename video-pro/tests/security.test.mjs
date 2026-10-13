import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';
import {createAuth} from '../lib/auth.mjs';
import {createBilling} from '../lib/billing.mjs';
async function fixture(t,env={},fetchImpl=async()=>{throw Error('Unexpected provider request')}){
 const dir=await mkdtemp(join(tmpdir(),'video-security-'));
 const {server}=await createApp({env,dataPath:join(dir,'jobs.json'),fetchImpl});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true})});
 const port=server.address().port;
 return async(path,options={})=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,path,method:options.method||'GET',headers:{Host:`127.0.0.1:${port}`,...options.headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:text,json:()=>JSON.parse(text)}))});
  req.on('error',reject);req.end(options.body);
 });
}
test('local host, origin and CSRF boundaries reject requests before mutation',async t=>{
 const request=await fixture(t);
 for(const headers of [{Host:'evil.example'},{Origin:'https://evil.example'},{'Sec-Fetch-Site':'cross-site'}])assert.equal((await request('/api/status',{headers})).status,403);
 const status=await request('/api/status');assert.equal(status.status,200);assert.equal(status.headers['x-frame-options'],'DENY');
 const valid={prompt:'A sunlit architectural studio',mode:'planning'};
 assert.equal((await request('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(valid)})).status,403);
 const headers={'Content-Type':'application/json','X-CSRF-Token':status.json().csrfToken};
 assert.equal((await request('/api/jobs',{method:'POST',headers,body:JSON.stringify(valid)})).status,201);
 assert.equal((await request('/api/jobs')).json().jobs.length,1);
});
test('malformed, oversized and invalid payloads fail without exposing secrets',async t=>{
 const secret='unique-private-credential-test';const request=await fixture(t,{GEMINI_API_KEY:secret});
 const result=await request('/api/status');assert.ok(!result.body.includes(secret));
 const headers={'Content-Type':'application/json','X-CSRF-Token':result.json().csrfToken};
 for(const [body,status] of [['{',400],['null',400],[JSON.stringify({prompt:'x'.repeat(70000)}),413]])assert.equal((await request('/api/jobs',{method:'POST',headers,body})).status,status);
 assert.equal((await request('/api/jobs',{method:'POST',headers:{...headers,'Content-Type':'text/plain'},body:'{}'})).status,415);
 assert.equal((await request('/.env')).status,404);
 assert.equal((await request('/lib/auth.mjs')).status,404);
 assert.equal((await request('/api/jobs')).json().jobs.length,0);
});
test('Supabase identity fails closed for incomplete configuration and unauthorized identities',async t=>{
 assert.throws(()=>createAuth({SUPABASE_URL:'https://example.supabase.co'}),/Incomplete/);
 const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test',SUPABASE_OWNER_IDS:'owner'};
 const request=await fixture(t,env,async()=>({ok:true,status:200,json:async()=>({id:'intruder',email_confirmed_at:'2026-01-01'})}));
 assert.equal((await request('/api/health')).status,200);
 assert.equal((await request('/api/status')).status,401);
 assert.equal((await request('/api/status',{headers:{Authorization:'Bearer token'}})).status,403);
 const unavailable=createAuth(env,async()=>{throw Error('private secret')});
 await assert.rejects(unavailable.verify({headers:{authorization:'Bearer token'}}),e=>e.status===503&&!e.message.includes('private secret'));
});
test('draft checkout remains disabled even when Stripe credentials exist',async t=>{
 const billing=await createBilling({STRIPE_RESTRICTED_KEY:'secret',STRIPE_WEBHOOK_SECRET:'secret'},{billingEnabled:false,unitEconomicsVerified:false,plans:[{id:'creator'}]});
 assert.equal(billing.enabled,false);
 await assert.rejects(billing.checkout('creator','http://localhost:1'),e=>e.status===503);
 const request=await fixture(t);const csrf=(await request('/api/status')).json().csrfToken;
 assert.equal((await request('/api/checkout',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{"planId":"creator"}'})).status,503);
});

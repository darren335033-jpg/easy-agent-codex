import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Stripe from 'stripe';
import {createApp} from '../server.mjs';
const identity={SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test',SUPABASE_OWNER_IDS:'owner'};
async function fixture(t,env={},fetchImpl=async()=>{throw Error('Unexpected external request')}){
 const dir=await mkdtemp(join(tmpdir(),'video-features-'));const app=await createApp({env,dataPath:join(dir,'jobs.json'),fetchImpl});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));app.ledger?.close();await rm(dir,{recursive:true,force:true})});
 const port=app.server.address().port;
 return async(path,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path,method,headers},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text,json:()=>JSON.parse(text)}))});req.on('error',reject);req.end(body)});
}
test('owner login stores opaque HttpOnly cookie, requires CSRF, logout invalidates despite upstream outage',async t=>{
 let logout=false;
 const request=await fixture(t,identity,async url=>{
  if(url.endsWith('/logout')){logout=true;throw Error('upstream outage')}
  if(url.includes('/token?'))return {ok:true,status:200,json:async()=>({access_token:'never-expose-access-token',expires_in:3600})};
  return {ok:true,status:200,json:async()=>({id:'owner',email_confirmed_at:'2026-01-01'})};
 });
 const csrf=(await request('/api/auth/config')).json().csrfToken;
 const body=JSON.stringify({email:'owner@example.com',password:'private-password'});
 assert.equal((await request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body})).status,403);
 const login=await request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body});
 assert.equal(login.status,200);assert.deepEqual(login.json(),{ok:true});assert.ok(!login.text.includes('access-token'));
 const cookie=login.headers['set-cookie'][0];assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.ok(!cookie.includes('never-expose'));
 const headers={Cookie:cookie.split(';')[0]};assert.equal((await request('/api/status',{headers})).status,200);
 assert.equal((await request('/api/auth/logout',{method:'POST',headers:{...headers,'X-CSRF-Token':csrf}})).status,200);
 assert.equal(logout,true);assert.equal((await request('/api/status',{headers})).status,401);
});
test('non-owner cannot create login session',async t=>{
 const request=await fixture(t,identity,async url=>({ok:true,status:200,json:async()=>url.includes('/token?')?{access_token:'token'}:{id:'intruder',email_confirmed_at:'2026-01-01'}}));
 const csrf=(await request('/api/auth/config')).json().csrfToken;
 const result=await request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{"email":"intruder@example.com","password":"x"}'});
 assert.equal(result.status,403);assert.equal(result.headers['set-cookie'],undefined);
});
test('signed webhook grants, deduplicates and revokes entitlement without provider network',async t=>{
 const secret='whsec_local_tests';const stripe=new Stripe('rk_test_local_tests');
 const request=await fixture(t,{...identity,STRIPE_RESTRICTED_KEY:'rk_test_local_tests',STRIPE_WEBHOOK_SECRET:secret},async()=>({ok:true,status:200,json:async()=>({id:'owner',email_confirmed_at:'2026-01-01'})}));
 const entitlement=()=>request('/api/entitlement',{headers:{Authorization:'Bearer owner-token'}});
 assert.equal((await request('/api/entitlement')).status,401);assert.equal((await entitlement()).json().active,false);
 const send=async event=>{const body=JSON.stringify(event);const signature=stripe.webhooks.generateTestHeaderString({payload:body,secret});return request('/api/billing/webhook',{method:'POST',headers:{'Stripe-Signature':signature,'Content-Type':'application/json'},body})};
 const created=Math.floor(Date.now()/1000);
 const event={id:'evt_paid',type:'checkout.session.completed',created,data:{object:{subscription:'sub_test',payment_status:'paid',metadata:{user_id:'owner',plan_id:'creator'}}}};
 assert.equal((await send(event)).json().status,'processed');assert.equal((await send(event)).json().status,'duplicate');assert.equal((await entitlement()).json().active,true);
 assert.equal((await send({id:'evt_deleted',type:'customer.subscription.deleted',created:created+1,data:{object:{id:'sub_test',metadata:{user_id:'owner',plan_id:'creator'}}}})).json().status,'processed');
 assert.equal((await entitlement()).json().active,false);
 assert.equal((await request('/api/billing/webhook',{method:'POST',headers:{'Stripe-Signature':'invalid'},body:'{}'})).status,400);
});
test('unconfigured webhook rejects without accepting events',async t=>{
 const request=await fixture(t);assert.equal((await request('/api/billing/webhook',{method:'POST',body:'{}'})).status,503);
});

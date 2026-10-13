import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders, publicProviderStatus } from '../lib/providers.mjs';
const input = {prompt:'A cat walks in a garden.',duration:8,aspectRatio:'16:9',resolution:'1080p'};
const env = {GEMINI_API_KEY:'secret-test-only'};
const ok = body => ({ok:true,json:async()=>body});
test('unconfigured providers do not exist and public metadata exposes no secrets',()=>{
  assert.deepEqual(createProviders({}),{});
  const status = publicProviderStatus({...env,RUNWAY_API_KEY:'private'});
  assert.equal(status[0].status,'credentials_present');
  assert.equal(status[1].status,'not_implemented');
  assert.doesNotMatch(JSON.stringify(status),/secret|private/);
});
test('submit uses documented body, private header, manual redirect and timeout',async()=>{
  let captured;
  const {veo}=createProviders(env,{fetchImpl:async(url,options)=>{captured={url,options};return ok({name:'models/veo-3.1-generate-preview/operations/test_123'});}});
  assert.equal((await veo.submit(input)).operationId,'models/veo-3.1-generate-preview/operations/test_123');
  assert.equal(captured.url,'https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning');
  assert.equal(captured.options.headers['x-goog-api-key'],env.GEMINI_API_KEY);
  assert.equal(captured.options.redirect,'manual'); assert.ok(captured.options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(captured.options.body),{instances:[{prompt:input.prompt}],parameters:{aspectRatio:'16:9',durationSeconds:8,resolution:'1080p'}});
  assert.doesNotMatch(captured.url,/secret/);
});
test('constraints and traversal are rejected before network',async()=>{
  let calls=0;
  const {veo}=createProviders(env,{fetchImpl:async()=>{calls++;return ok({});}});
  for(const changes of [{duration:6},{aspectRatio:'1:1'},{duration:5},{resolution:'4k'}]) await assert.rejects(veo.submit({...input,...changes}),{status:400});
  for(const operation of ['../operations/a','operations/a?key=x','operations/a/b','https://evil.example/operations/a','models/other/operations/a']) await assert.rejects(veo.poll(operation),{status:400});
  assert.equal(calls,0);
});
test('provider errors and aborts are sanitized without retry',async()=>{
  for(const fake of [async()=>{throw new Error('secret-test-only payload');},async()=>({ok:false,json:async()=>({error:'secret-test-only'})}),async()=>{throw new DOMException('secret-test-only','TimeoutError');}]) {
    let calls=0;
    const {veo}=createProviders(env,{fetchImpl:async(...args)=>{calls++;return fake(...args);}});
    await assert.rejects(veo.submit(input),error=>error.status===502 && !error.message.includes('secret'));
    assert.equal(calls,1);
  }
});
test('poll accepts documented operations, handles blocked output and restricts URLs',async()=>{
  let response={done:false};
  const {veo}=createProviders(env,{fetchImpl:async()=>ok(response)});
  assert.equal((await veo.poll('operations/test')).status,'running');
  response={done:true,response:{}};
  assert.equal((await veo.poll('operations/test')).status,'failed');
  for(const uri of ['https://evil.example/a','http://storage.googleapis.com/a','https://storage.googleapis.com.evil.example/a','https://user@storage.googleapis.com/a']) {
    response={done:true,response:{generateVideoResponse:{generatedSamples:[{video:{uri}}]}}};
    assert.equal((await veo.poll('operations/test')).status,'failed');
  }
  const uri='https://generativelanguage.googleapis.com/v1beta/files/video:download';
  response={done:true,response:{generateVideoResponse:{generatedSamples:[{video:{uri}}]}}};
  assert.deepEqual(await veo.poll('operations/test'),{status:'succeeded',videoUrl:uri});
  response={error:{message:'secret-test-only'}};
  assert.deepEqual(await veo.poll('operations/test'),{status:'failed',error:'Video provider generation failed.'});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunwayProviders} from '../lib/runway.mjs';
const env={RUNWAY_API_KEY:'private-test-key'};
const id='12345678-1234-1234-1234-123456789abc';
const input={prompt:'A cat walks through a sunny garden.',duration:6,aspectRatio:'16:9',resolution:'720p'};
const ok=data=>({ok:true,json:async()=>data});
test('absent credentials create no providers',()=>assert.deepEqual(createRunwayProviders({}),{}));
test('exact Gen4.5 and Seedance bodies and private headers',async()=>{
  const requests=[];
  const providers=createRunwayProviders(env,{fetchImpl:async(url,options)=>{requests.push({url,options});return ok({id});}});
  assert.deepEqual(await providers.runway.submit(input),{operationId:id});
  await providers.seedance.submit({...input,aspectRatio:'1:1',resolution:'1080p'});
  assert.deepEqual(JSON.parse(requests[0].options.body),{model:'gen4.5',promptText:input.prompt,duration:6,ratio:'1280:720'});
  assert.deepEqual(JSON.parse(requests[1].options.body),{model:'seedance2',promptText:input.prompt,duration:6,ratio:'1440:1440'});
  assert.equal(requests[0].url,'https://api.dev.runwayml.com/v1/text_to_video');
  assert.equal(requests[0].options.headers.Authorization,'Bearer private-test-key');
  assert.equal(requests[0].options.headers['X-Runway-Version'],'2024-11-06');
  assert.equal(requests[0].options.redirect,'manual');assert.ok(requests[0].options.signal instanceof AbortSignal);
});
test('provider restrictions and unsafe operation paths prevent calls',async()=>{
  let calls=0;
  const providers=createRunwayProviders(env,{fetchImpl:async()=>{calls++;return ok({id});}});
  for(const change of [{prompt:'a'.repeat(1001)},{aspectRatio:'1:1'},{resolution:'1080p'},{duration:5}]) await assert.rejects(providers.runway.submit({...input,...change}),{status:400});
  await assert.rejects(providers.seedance.submit({...input,prompt:'a'.repeat(3501)}),{status:400});
  for(const path of ['../tasks/a',`${id}?key=x`,'https://evil.example/task','not-uuid']) await assert.rejects(providers.runway.poll(path),{status:400});
  assert.equal(calls,0);
});
test('poll maps statuses and uses only API endpoint for private credentials',async()=>{
  let data;const requests=[];
  const {runway}=createRunwayProviders(env,{fetchImpl:async(url,options)=>{requests.push({url,options});return ok(data);}});
  for(const [upstream,expected] of [['PENDING','queued'],['THROTTLED','queued'],['RUNNING','running'],['FAILED','failed'],['CANCELED','failed'],['CANCELLED','failed']]) {
    data={status:upstream,failure:'private-test-key'};assert.equal((await runway.poll(id)).status,expected);
  }
  data={status:'SUCCEEDED',output:['https://cdn.example.com/signed.mp4?token=test']};
  assert.equal((await runway.poll(id)).videoUrl,data.output[0]);
  for(const output of ['http://cdn.example.com/a','https://user:pass@cdn.example.com/a','invalid']) {
    data={status:'SUCCEEDED',output:[output]};assert.equal((await runway.poll(id)).status,'failed');
  }
  assert.ok(requests.every(request=>request.url===`https://api.dev.runwayml.com/v1/tasks/${id}`));
});
test('errors are sanitized and submission never retries',async()=>{
  for(const fake of [async()=>{throw new Error('private-test-key');},async()=>({ok:false}),async()=>{throw new DOMException('private-test-key','TimeoutError');}]) {
    let calls=0;
    const {runway}=createRunwayProviders(env,{fetchImpl:async(...args)=>{calls++;return fake(...args);}});
    await assert.rejects(runway.submit(input),error=>error.status===502&&!error.message.includes('private'));
    assert.equal(calls,1);
  }
});

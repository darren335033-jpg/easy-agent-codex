import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../lib/jobs.mjs';
const request = { prompt: 'A cat walks through a sunny garden.' };
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'video-jobs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new JobStore({ filePath: join(directory, 'jobs.json'), ...options }).init();
}
test('planning is honest, persisted privately and survives reload', async t => {
  const store = await fixture(t);
  const job = await store.create(request);
  assert.equal(job.status, 'planned'); assert.equal(job.videoUrl, undefined);
  assert.equal(job.storyboard.length, 3); assert.equal(job.qc.every(q => q.status === 'pending'), true);
  assert.equal((await stat(store.filePath)).mode & 0o777, 0o600);
  const restored = await new JobStore({ filePath: store.filePath }).init();
  assert.deepEqual(restored.get(job.id), job);
  const exposed = store.list(); exposed[0].status = 'succeeded';
  assert.equal(store.get(job.id).status, 'planned');
});
test('rejects invalid input and disabled or missing live providers', async t => {
  const store = await fixture(t);
  for (const input of [{prompt:'short'}, {...request,provider:'unknown'}, {...request,duration:5}, {...request,aspectRatio:'4:3'}, {...request,resolution:'4k'}, {...request,mode:'magic'}]) {
    await assert.rejects(store.create(input), { status: 400 });
  }
  await assert.rejects(store.create({...request,mode:'live'},{idempotencyKey:'live-test'}), { status:503 });
  store.liveEnabled = true;
  await assert.rejects(store.create({...request,mode:'live'},{idempotencyKey:'live-test'}), { status:503 });
  assert.equal(store.list().length, 0);
});
test('concurrent creates preserve all jobs and enforce capacity', async t => {
  const store = await fixture(t, {maxJobs:20});
  await Promise.all(Array.from({length:20}, (_, i) => store.create({...request,prompt:`${request.prompt} ${i}`})));
  assert.equal(store.list().length,20);
  assert.equal(JSON.parse(await readFile(store.filePath,'utf8')).jobs.length,20);
  await assert.rejects(store.create(request), {status:429});
});
test('concurrent idempotent requests submit once and conflicting input fails', async t => {
  let submits = 0;
  const store = await fixture(t, {liveEnabled:true,providers:{veo:{submit:async()=>({operationId:`op-${++submits}`}),poll:async()=>({status:'running'})}}});
  const input = {...request,mode:'live'};
  const jobs = await Promise.all(Array.from({length:5},()=>store.create(input,{idempotencyKey:'same'})));
  assert.equal(new Set(jobs.map(j=>j.id)).size,1); assert.equal(submits,1);
  await assert.rejects(store.create({...input,duration:8},{idempotencyKey:'same'}), {status:409});
  const restored = await new JobStore({filePath:store.filePath}).init();
  assert.equal((await restored.create(input,{idempotencyKey:'same'})).id,jobs[0].id);
});
test('poll transitions produce video only on success', async t => {
  const states = [{status:'running'},{status:'succeeded',videoUrl:'https://example.com/video.mp4'}];
  const store = await fixture(t,{liveEnabled:true,providers:{veo:{submit:async()=>({operationId:'op'}),poll:async()=>states.shift()}}});
  const job = await store.create({...request,mode:'live'},{idempotencyKey:'live-test'});
  assert.equal((await store.refresh(job.id)).status,'running');
  assert.equal((await store.refresh(job.id)).videoUrl,'https://example.com/video.mp4');
  await assert.rejects(store.cancel(job.id),{status:409});
});
test('late poll cannot overwrite local cancellation', async t => {
  let release;
  const store = await fixture(t,{liveEnabled:true,providers:{veo:{submit:async()=>({operationId:'op'}),poll:()=>new Promise(resolve=>{release=resolve;})}}});
  const job = await store.create({...request,mode:'live'},{idempotencyKey:'live-test'});
  const pending = store.refresh(job.id);
  const cancelled = await store.cancel(job.id);
  assert.match(cancelled.cancellationNote,/Upstream generation may continue/);
  release({status:'succeeded',videoUrl:'https://example.com/video.mp4'});
  assert.equal((await pending).status,'cancelled'); assert.equal(store.get(job.id).videoUrl,undefined);
});
test('provider failures remain explicit without fallback', async t => {
  const store = await fixture(t,{liveEnabled:true,providers:{veo:{submit:async()=>({operationId:'op'}),poll:async()=>({status:'failed',error:'Quota exhausted'})}}});
  const job = await store.create({...request,mode:'live'},{idempotencyKey:'live-test'});
  assert.equal((await store.refresh(job.id)).error,'Quota exhausted');
  await assert.rejects(store.refresh((await store.create(request)).id),{status:503});
  await assert.rejects(store.cancel('missing'),{status:404});
});
test('durable intent failure prevents a paid submission', async t => {
  let submits = 0;
  const store = await fixture(t,{liveEnabled:true,providers:{veo:{submit:async()=>({operationId:`op-${++submits}`}),poll:async()=>({status:'running'})}}});
  store.persist = async()=>{throw new Error('disk full');};
  await assert.rejects(store.create({...request,mode:'live'},{idempotencyKey:'disk'}));
  assert.equal(submits,0); assert.equal(store.list().length,0);
});
test('ambiguous provider failure preserves idempotency and never resubmits', async t => {
  let submits = 0;
  const store = await fixture(t,{liveEnabled:true,providers:{veo:{submit:async()=>{submits++;throw new Error('timeout');},poll:async()=>({status:'running'})}}});
  const input={...request,mode:'live'};
  await assert.rejects(store.create(input,{idempotencyKey:'unknown'}),error=>Boolean(error.jobId));
  const retried=await store.create(input,{idempotencyKey:'unknown'});
  assert.equal(retried.status,'submission_unknown'); assert.equal(submits,1);
  const restored=await new JobStore({filePath:store.filePath}).init();
  assert.equal((await restored.create(input,{idempotencyKey:'unknown'})).id,retried.id);
});
test('disk failure after paid submit leaves recoverable durable intent', async t => {
  let submits=0;
  const store = await fixture(t,{liveEnabled:true,providers:{veo:{submit:async()=>({operationId:`op-${++submits}`}),poll:async()=>({status:'running'})}}});
  const persist=store.persist.bind(store); let writes=0;
  store.persist=async()=>{if(++writes>1) throw new Error('disk unavailable');return persist();};
  const input={...request,mode:'live'};
  await assert.rejects(store.create(input,{idempotencyKey:'durable'}));
  assert.equal(store.list()[0].status,'submission_unknown'); assert.equal(store.list()[0].operationId,'op-1');
  const restored=await new JobStore({filePath:store.filePath,providers:store.providers,liveEnabled:true}).init();
  assert.equal((await restored.create(input,{idempotencyKey:'durable'})).status,'submission_unknown');
  assert.equal(submits,1);
  assert.equal(JSON.parse(await readFile(store.filePath,'utf8')).jobs[0].status,'submission_unknown');
});
test('live requires idempotency and provider validation precedes intent', async t => {
  const { createProviders } = await import('../lib/providers.mjs');
  let calls=0;
  const store=await fixture(t,{liveEnabled:true,providers:createProviders({GEMINI_API_KEY:'test'},{fetchImpl:async()=>{calls++;throw new Error('unexpected');}})});
  await assert.rejects(store.create({...request,mode:'live'}),{status:400});
  for (const settings of [{aspectRatio:'1:1'},{resolution:'1080p',duration:6}]) {
    await assert.rejects(store.create({...request,mode:'live',...settings},{idempotencyKey:'invalid'}),{status:400});
  }
  assert.equal(calls,0); assert.equal(store.list().length,0);
});
test('symlink storage targets and directories are rejected', async t => {
  const { symlink, mkdir } = await import('node:fs/promises');
  const store=await fixture(t);
  await symlink(join(dirnameForTest(store.filePath),'other.json'),store.filePath);
  await assert.rejects(new JobStore({filePath:store.filePath}).init(),{status:400});
  const real=join(dirnameForTest(store.filePath),'real');await mkdir(real);
  const linked=join(dirnameForTest(store.filePath),'linked');await symlink(real,linked);
  await assert.rejects(new JobStore({filePath:join(linked,'jobs.json')}).init(),{status:400});
});
function dirnameForTest(path) { return path.slice(0,path.lastIndexOf('/')); }
test('invalid persisted version and excess records are rejected', async t => {
  const {writeFile}=await import('node:fs/promises');
  const store=await fixture(t,{maxJobs:1});
  await writeFile(store.filePath,JSON.stringify({version:2,jobs:[]}));
  await assert.rejects(new JobStore({filePath:store.filePath}).init(),/Invalid job store/);
  await writeFile(store.filePath,JSON.stringify({version:1,jobs:[{id:'a',status:'planned',prompt:'x'},{id:'b',status:'planned',prompt:'x'}]}));
  await assert.rejects(new JobStore({filePath:store.filePath,maxJobs:1}).init(),/Invalid job store/);
});

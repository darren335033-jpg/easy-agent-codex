import { readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { protectDirectory, protectFileSync } from './storage-security.mjs';
const fail = (status, message) => Object.assign(new Error(message), { status });
const clone = value => structuredClone(value);
function normalize(input) {
  if (!input || typeof input !== 'object') throw fail(400, 'A job request is required.');
  const { prompt, provider = 'veo', duration = 6, aspectRatio = '16:9', resolution = '720p', mode = 'planning' } = input;
  if (typeof prompt !== 'string' || prompt.trim().length < 10 || prompt.length > 4000) throw fail(400, 'Prompt must contain 10–4000 characters.');
  if (!['veo','runway','seedance','local'].includes(provider)) throw fail(400, 'Invalid provider.');
  if (![4,6,8].includes(duration)) throw fail(400, 'Invalid duration.');
  if (!['16:9','9:16','1:1'].includes(aspectRatio)) throw fail(400, 'Invalid aspect ratio.');
  if (!['720p','1080p'].includes(resolution)) throw fail(400, 'Invalid resolution.');
  if (!['planning','live'].includes(mode)) throw fail(400, 'Invalid mode.');
  return { prompt: prompt.trim(), provider, duration, aspectRatio, resolution, mode };
}
export class JobStore {
  constructor({ filePath, providers = {}, liveEnabled = false, maxJobs = 500 }) {
    if (!filePath || !Number.isInteger(maxJobs) || maxJobs < 1) throw fail(400, 'A file path and positive job limit are required.');
    Object.assign(this, { filePath, providers, liveEnabled, maxJobs });
    this.jobs = []; this.tail = Promise.resolve();
  }
  async init() {
    await protectDirectory(dirname(resolve(this.filePath)));
    await this.checkStorageTarget();
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.jobs) || data.jobs.length > this.maxJobs || data.jobs.some(job => !job || typeof job.id !== 'string' || typeof job.status !== 'string' || typeof job.prompt !== 'string')) throw new Error('Invalid job store.');
      this.jobs = data.jobs;
      let recovered = false;
      for (const job of this.jobs) {
        if (job.status === 'submitting') { job.status = 'submission_unknown'; recovered = true; }
      }
      if (recovered) await this.persist();
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this;
  }
  list() { return this.jobs.map(({ idempotencyKey, requestSignature, ...job }) => clone(job)); }
  get(id) {
    const job = this.jobs.find(job => job.id === id);
    if (!job) throw fail(404, 'Job not found.');
    const { idempotencyKey, requestSignature, ...publicJob } = job;
    return clone(publicJob);
  }
  async checkStorageTarget() {
    try {
      if ((await lstat(this.filePath)).isSymbolicLink()) throw fail(400, 'Job storage must not be a symlink.');
      protectFileSync(this.filePath);
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async persist() {
    await this.checkStorageTarget();
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, jobs: this.jobs }), { mode: 0o600 });
    protectFileSync(temporary);
    await rename(temporary, this.filePath);
  }
  transact(action) {
    const result = this.tail.then(async () => {
      const previous = clone(this.jobs);
      try { return await action(); } catch (error) { if (!error.preserveJobs) this.jobs = previous; throw error; }
    });
    this.tail = result.catch(() => {});
    return result;
  }
  async create(input, { idempotencyKey } = {}) {
    const request = normalize(input);
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyKey.length || idempotencyKey.length > 200)) throw fail(400, 'Invalid idempotency key.');
    if (request.mode === 'live' && !idempotencyKey) throw fail(400, 'Live requests require an idempotency key.');
    return this.transact(async () => {
      const signature = JSON.stringify(request);
      const existing = idempotencyKey && this.jobs.find(job => job.idempotencyKey === idempotencyKey);
      if (existing) {
        if (existing.requestSignature !== signature) throw fail(409, 'Idempotency key already belongs to a different request.');
        return this.get(existing.id);
      }
      if (this.jobs.length >= this.maxJobs) throw fail(429, 'Job capacity reached.');
      const provider = this.providers[request.provider];
      if (request.mode === 'live' && (!this.liveEnabled || typeof provider?.submit !== 'function' || typeof provider?.poll !== 'function')) throw fail(503, 'Live generation is disabled or this provider is unconfigured.');
      const job = { id: randomUUID(), ...request, status: 'planned', createdAt: new Date().toISOString(), storyboard: [
        { shot: 1, description: `Establish the scene: ${request.prompt}`, duration: request.duration / 3 },
        { shot: 2, description: `Develop the main action: ${request.prompt}`, duration: request.duration / 3 },
        { shot: 3, description: `Resolve the scene: ${request.prompt}`, duration: request.duration / 3 }
      ], qc: ['Character consistency','Temporal flicker and motion','Prompt adherence','Audio synchronization','Human review'].map(name => ({ name, status: 'pending' })), idempotencyKey, requestSignature: signature };
      if (request.mode === 'live') {
        if (typeof provider.validate === 'function') await provider.validate(clone(request));
        job.status = 'submitting';
        this.jobs.push(job);
        // Durable intent precedes the paid request. Failure here makes no provider call.
        await this.persist();
        try {
          const operation = await provider.submit(clone(request));
          if (!operation || typeof operation.operationId !== 'string' || !operation.operationId) throw fail(502, 'Provider returned an invalid operation.');
          job.operationId = operation.operationId;
          job.status = 'queued';
          await this.persist();
        } catch (error) {
          // A timeout or post-submit disk failure cannot prove the paid request failed.
          job.status = 'submission_unknown';
          job.error = 'Submission outcome is unknown. Retrying this job will not submit again.';
          try { await this.persist(); } catch { /* The durable submitting intent remains. */ }
          const safeError = fail(error.status || 503, 'Submission outcome is unknown. Check the existing job before creating another request.');
          safeError.preserveJobs = true;
          safeError.jobId = job.id;
          throw safeError;
        }
        return this.get(job.id);
      }
      this.jobs.push(job); await this.persist(); return this.get(job.id);
    });
  }
  async cancel(id) {
    return this.transact(async () => {
      const job = this.jobs.find(job => job.id === id);
      if (!job) throw fail(404, 'Job not found.');
      if (['succeeded','failed'].includes(job.status)) throw fail(409, 'Completed jobs cannot be cancelled.');
      const unknown = ['submitting','submission_unknown'].includes(job.status);
      job.status = 'cancelled'; job.cancellationNote = unknown
        ? 'Cancelled locally. Upstream submission outcome is unknown; generation may continue and incur charges.'
        : 'Cancelled locally. Upstream generation may continue and incur charges.';
      await this.persist(); return this.get(id);
    });
  }
  async refresh(id) {
    const job = this.get(id);
    if (job.mode !== 'live' || !job.operationId || typeof this.providers[job.provider]?.poll !== 'function') throw fail(503, 'This job has no configured live operation.');
    if (['cancelled','succeeded','failed'].includes(job.status)) return job;
    const result = await this.providers[job.provider].poll(job.operationId);
    if (!result || !['queued','running','succeeded','failed'].includes(result.status)) throw fail(502, 'Provider returned an invalid job status.');
    if (result.status === 'succeeded' && (typeof result.videoUrl !== 'string' || !/^https?:\/\//.test(result.videoUrl))) throw fail(502, 'Provider returned no valid video URL.');
    return this.transact(async () => {
      const current = this.jobs.find(item => item.id === id);
      if (['cancelled','succeeded','failed'].includes(current.status)) return this.get(id);
      if (current.status === 'running' && result.status === 'queued') return this.get(id);
      current.status = result.status;
      if (result.status === 'succeeded') current.videoUrl = result.videoUrl;
      if (result.status === 'failed') current.error = typeof result.error === 'string' ? result.error : 'Provider generation failed.';
      await this.persist(); return this.get(id);
    });
  }
}

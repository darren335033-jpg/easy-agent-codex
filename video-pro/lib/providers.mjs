const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = 'veo-3.1-generate-preview';
const operationPattern = /^(?:models\/veo-3\.1-generate-preview\/)?operations\/[A-Za-z0-9_-]+$/;
const failure = (status, message) => Object.assign(new Error(message), { status });
function allowedVideo(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname === 'generativelanguage.googleapis.com' || url.hostname === 'storage.googleapis.com' || url.hostname.endsWith('.googleapis.com'));
  } catch { return false; }
}
export function publicProviderStatus(env = {}) {
  return [
    { id: 'veo', status: env.GEMINI_API_KEY ? 'credentials_present' : 'unconfigured' },
    { id: 'runway', status: env.RUNWAY_API_KEY ? 'not_implemented' : 'unconfigured' },
    { id: 'seedance', status: env.SEEDANCE_API_KEY ? 'not_implemented' : 'unconfigured' },
    { id: 'local', status: 'not_implemented' }
  ];
}
export function createProviders(env = {}, { fetchImpl = fetch } = {}) {
  if (!env.GEMINI_API_KEY) return {};
  const key = env.GEMINI_API_KEY;
  async function request(path, options = {}) {
    try {
      const response = await fetchImpl(`${BASE}/${path}`, {
        ...options, redirect: 'manual', signal: AbortSignal.timeout(30_000),
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }
      });
      if (!response.ok) throw failure(502, 'Video provider request failed.');
      return await response.json();
    } catch { throw failure(502, 'Video provider request failed.'); }
  }
  function validate(input) {
      if (typeof input?.prompt !== 'string' || input.prompt.trim().length < 10 || input.prompt.length > 4000) throw failure(400, 'Invalid video prompt.');
      if (![4,6,8].includes(input.duration) || !['16:9','9:16'].includes(input.aspectRatio) || !['720p','1080p'].includes(input.resolution)) throw failure(400, 'Unsupported Veo video settings.');
      if (input.resolution === '1080p' && input.duration !== 8) throw failure(400, 'Veo 1080p requires an 8-second duration.');
  }
  return { veo: {
    validate,
    async submit(input) {
      validate(input);
      const data = await request(`models/${MODEL}:predictLongRunning`, {
        method: 'POST', body: JSON.stringify({ instances: [{ prompt: input.prompt }], parameters: { aspectRatio: input.aspectRatio, durationSeconds: input.duration, resolution: input.resolution } })
      });
      if (typeof data?.name !== 'string' || !operationPattern.test(data.name)) throw failure(502, 'Video provider returned an invalid operation.');
      return { operationId: data.name };
    },
    async poll(operationId) {
      if (typeof operationId !== 'string' || !operationPattern.test(operationId)) throw failure(400, 'Invalid video operation.');
      const data = await request(operationId, { method: 'GET' });
      if (data?.error) return { status: 'failed', error: 'Video provider generation failed.' };
      if (!data?.done) return { status: 'running' };
      const uri = data.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!allowedVideo(uri)) return { status: 'failed', error: 'Video provider returned no accessible video.' };
      return { status: 'succeeded', videoUrl: uri };
    }
  } };
}

const BASE = 'https://api.dev.runwayml.com/v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, message) => Object.assign(new Error(message), { status });
const ratios = {
  '720p': {'16:9':'1280:720','9:16':'720:1280','1:1':'960:960'},
  '1080p': {'16:9':'1920:1080','9:16':'1080:1920','1:1':'1440:1440'}
};
function videoUrl(value) {
  try {
    const url=new URL(value);
    return url.protocol==='https:' && !url.username && !url.password && !url.port;
  } catch { return false; }
}
export function createRunwayProviders(env = {}, { fetchImpl = fetch } = {}) {
  if (!env.RUNWAY_API_KEY) return {};
  async function request(path, options) {
    try {
      const response=await fetchImpl(`${BASE}/${path}`,{...options,redirect:'manual',signal:AbortSignal.timeout(30_000),headers:{Authorization:`Bearer ${env.RUNWAY_API_KEY}`,'X-Runway-Version':'2024-11-06','Content-Type':'application/json'}});
      if(!response.ok) throw new Error();
      return await response.json();
    } catch { throw fail(502,'Video provider request failed.'); }
  }
  function adapter(model) {
    const seedance=model==='seedance2';
    function validate(input) {
      if(typeof input?.prompt!=='string' || input.prompt.trim().length<10 || input.prompt.length>(seedance?3500:1000)) throw fail(400,'Prompt exceeds this provider’s supported limits.');
      if(![4,6,8].includes(input.duration) || !ratios[input.resolution]?.[input.aspectRatio]) throw fail(400,'Unsupported video settings.');
      if(!seedance && (input.resolution!=='720p' || input.aspectRatio==='1:1')) throw fail(400,'Gen-4.5 supports landscape or portrait 720p video.');
    }
    return {
      validate,
      async submit(input) {
        validate(input);
        const data=await request('text_to_video',{method:'POST',body:JSON.stringify({model,promptText:input.prompt,duration:input.duration,ratio:ratios[input.resolution][input.aspectRatio]})});
        if(typeof data?.id!=='string' || !uuid.test(data.id)) throw fail(502,'Video provider returned an invalid operation.');
        return {operationId:data.id};
      },
      async poll(operationId) {
        if(typeof operationId!=='string' || !uuid.test(operationId)) throw fail(400,'Invalid video operation.');
        const data=await request(`tasks/${operationId}`,{method:'GET'});
        if(['PENDING','THROTTLED'].includes(data?.status)) return {status:'queued'};
        if(data?.status==='RUNNING') return {status:'running'};
        if(['FAILED','CANCELED','CANCELLED'].includes(data?.status)) return {status:'failed',error:'Video provider generation failed or was cancelled.'};
        if(data?.status==='SUCCEEDED') {
          const uri=data.output?.[0];
          if(!videoUrl(uri)) return {status:'failed',error:'Video provider returned no accessible video.'};
          return {status:'succeeded',videoUrl:uri};
        }
        throw fail(502,'Video provider returned an invalid job status.');
      }
    };
  }
  return {runway:adapter('gen4.5'),seedance:adapter('seedance2')};
}

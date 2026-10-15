import { appError, googleToken } from './auth.mjs';
import { generateOpenAI, hasOpenAIKey } from './openai.mjs';
export const VERTEX_MCP_URL='https://aiplatform.googleapis.com/mcp/generate';
export const DEFAULT_MODEL='gemini-3.8-flash';
export function providerStatus(env={},runtime='cloud',hasADC=false) {
  const credentials=!!(env.GOOGLE_ACCESS_TOKEN||env.GOOGLE_SERVICE_ACCOUNT_JSON||hasADC);
  return {
    openai:{configured:hasOpenAIKey(env),verified:false,reason:hasOpenAIKey(env)?'Server API key available; model access is verified when you run a task. API usage is billed separately from ChatGPT or Codex subscriptions.':'Set OPENAI_API_KEY on the application server or local companion.',model:env.OPENAI_MODEL||''},
    vertex:{configured:credentials,reason:credentials?'Server credentials available; model access is verified when you run a task.':'Google Cloud credentials required. Set server credentials or use local Application Default Credentials.',model:env.VERTEX_MODEL||DEFAULT_MODEL,projectId:env.GOOGLE_CLOUD_PROJECT||'',location:env.GOOGLE_CLOUD_LOCATION||'global'},
    local:{configured:runtime==='local',reason:runtime==='local'?'Local runtime available. Ollama model availability is checked when you run a task.':'Run the local companion on your computer to use Ollama.',model:env.OLLAMA_MODEL||'qwen2.5-coder:7b'}
  };
}
export async function readProviderJson(response, label='Provider') {
  if(!response.ok) {
    await response.body?.cancel().catch(()=>{});
    const messages={401:'authentication failed',403:'access denied; check billing, project, API enablement and IAM permissions',404:'model or endpoint not available',429:'rate limit or quota exceeded'};
    throw appError(`${label} ${messages[response.status]||`request failed (HTTP ${response.status})`}.`,response.status<400||response.status>=500?502:response.status,'PROVIDER_ERROR');
  }
  const reader=response.body?.getReader();
  if(!reader) throw appError(`${label} returned an empty response.`,502,'PROVIDER_ERROR');
  let bytes=0,text=''; const decoder=new TextDecoder();
  const sse=response.headers.get('content-type')?.includes('text/event-stream');
  let consumed=0;
  for(;;) {
    const {done,value}=await reader.read(); if(done)break;
    bytes+=value.byteLength;
    if(bytes>2097152){await reader.cancel(); throw appError(`${label} response exceeded the size limit.`,502,'PROVIDER_ERROR');}
    text+=decoder.decode(value,{stream:true});
    if(sse){
      const remaining=text.slice(consumed);const frames=remaining.split(/\r?\n\r?\n/);
      for(const frame of frames.slice(0,-1)){
        consumed+=frame.length+(text.slice(consumed+frame.length).startsWith('\r\n')?4:2);
        const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');
        try {const event=JSON.parse(data);if(event.result||event.error){await reader.cancel().catch(()=>{});return event;}}catch{}
      }
    }
  }
  text+=decoder.decode();
  try {return JSON.parse(text);} catch {
    const events=text.split(/\r?\n\r?\n/).map(event=>event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n')).filter(Boolean);
    for(let i=events.length-1;i>=0;i--){try { const event=JSON.parse(events[i]); if(event.result||event.error) return event; }catch{}}
    throw appError(`${label} returned an unreadable response.`,502,'PROVIDER_ERROR');
  }
}
function checkResource(value,label) {
  if(typeof value!=='string'||!value||value.length>150||!/^[a-zA-Z0-9._-]+$/.test(value)) throw appError(`Enter a valid ${label}.`);
  return value;
}
function extractVertex(result) {
  if(result.error || result.result?.isError) throw appError('Vertex MCP tool execution failed. Check project access, model name and billing.',502,'PROVIDER_ERROR');
  const inner=result.result;
  let payload=inner?.structuredContent||inner;
  if(!payload?.candidates && inner?.content){
    for(const part of inner.content){ if(part.type==='text'){try {const json=JSON.parse(part.text); if(json.candidates){payload=json;break;}}catch{}} }
  }
  const output=payload?.candidates?.flatMap(c=>c.content?.parts||[]).filter(p=>p.text&&!p.thought).map(p=>p.text).join('\n');
  if(!output) throw appError('Vertex returned no text. The model may have blocked or truncated the response.',502,'EMPTY_OUTPUT');
  return {text:output,usage:payload.usageMetadata||{},usageReported:!!payload.usageMetadata&&Object.values(payload.usageMetadata).some(value=>Number.isSafeInteger(value)&&value>=0)};
}
export async function generate({provider,model,projectId,location,system,prompt,responseFormat,messages},env={},options={}) {
  const fetcher=options.fetch||globalThis.fetch.bind(globalThis);
  const signal=options.signal||AbortSignal.timeout(180000);
  const conversation=Array.isArray(messages)?messages:[{role:'user',content:prompt}];
  if(!conversation.length||conversation.length>100||conversation.some(m=>!m||!['user','assistant'].includes(m.role)||typeof m.content!=='string')||conversation.reduce((n,m)=>n+m.content.length,0)>600000)throw appError('The model conversation exceeds its supported limits.');
  if(provider==='openai') return generateOpenAI({model,system,prompt,responseFormat,messages:conversation},env,options);
  if(provider==='vertex') {
    const project=checkResource(projectId||env.GOOGLE_CLOUD_PROJECT,'Google Cloud project ID');
    const region=checkResource(location||env.GOOGLE_CLOUD_LOCATION||'global','Vertex location');
    const modelId=checkResource(model||env.VERTEX_MODEL||DEFAULT_MODEL,'Vertex model ID');
    const token=await googleToken(env,options);
    const response=await fetcher(VERTEX_MCP_URL,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/call'},body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',params:{name:'generate_content',arguments:{model:`projects/${project}/locations/${region}/publishers/google/models/${modelId}`,contents:conversation.map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]})),systemInstruction:{parts:[{text:system}]},generationConfig:{maxOutputTokens:8192,temperature:0.2,...(responseFormat==='json'?{responseMimeType:'application/json'}:{})}},_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}}}),redirect:'manual',signal});
    return extractVertex(await readProviderJson(response,'Vertex AI'));
  }
  if(provider==='local') {
    if(options.runtime!=='local') throw appError('Local models are available in the local companion. Run npm start on your computer.',503,'LOCAL_RUNTIME_REQUIRED');
    // The browser cannot choose a network destination. Only the server owner sets OLLAMA_BASE_URL.
    let base;try {base=new URL(env.OLLAMA_BASE_URL||'http://127.0.0.1:11434');} catch {throw appError('OLLAMA_BASE_URL is invalid.',503,'PROVIDER_NOT_CONFIGURED');}
    if(!['http:','https:'].includes(base.protocol)||base.username||base.password) throw appError('OLLAMA_BASE_URL must be an HTTP endpoint without embedded credentials.',503);
    const localModel=model||env.OLLAMA_MODEL||'qwen2.5-coder:7b';
    if(typeof localModel!=='string'||localModel.length>150||!localModel.trim()) throw appError('Enter a local model name.');
    const configuredContext=Number(env.OLLAMA_CONTEXT_WINDOW||8192);
    const contextWindow=Number.isInteger(configuredContext)&&configuredContext>=2048&&configuredContext<=131072?configuredContext:8192;
    const response=await fetcher(new URL('/api/chat',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:localModel,stream:false,...(responseFormat==='json'?{format:'json'}:{}),messages:[{role:'system',content:system},...conversation],options:{num_ctx:contextWindow,num_predict:8192,temperature:0.2}}),redirect:'manual',signal});
    const result=await readProviderJson(response,'Ollama');
    if(!result.message?.content) throw appError('Ollama returned no content. Check that the model is installed.',502,'EMPTY_OUTPUT');
    const reported=Number.isSafeInteger(result.prompt_eval_count)&&result.prompt_eval_count>=0&&Number.isSafeInteger(result.eval_count)&&result.eval_count>=0;
    return {text:result.message.content,usage:{promptTokenCount:reported?result.prompt_eval_count:0,candidatesTokenCount:reported?result.eval_count:0,totalTokenCount:reported?result.prompt_eval_count+result.eval_count:0},usageReported:reported};
  }
  throw appError('Choose OpenAI, Vertex AI or local Ollama.');
}

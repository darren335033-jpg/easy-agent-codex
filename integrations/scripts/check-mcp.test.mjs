import test from 'node:test';
import assert from 'node:assert/strict';
import {checkMcp} from './check-mcp.mjs';
function fixture({sse=false,notification=204}={}){
 const calls=[];let canceled=0;
 const fetchImpl=async(url,options)=>{const request=JSON.parse(options.body);calls.push({url,options,request});
  if(request.method==='notifications/initialized')return new Response(null,{status:notification});
  const result=request.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{}}:{tools:[{name:'safe_catalog_tool'}]};
  const payload={jsonrpc:'2.0',id:request.id,result};
  if(sse){const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(`: keepalive\n\ndata: ${JSON.stringify({...payload,id:99})}\n\ndata: ${JSON.stringify(payload)}\n\n`))},cancel(){canceled++}});return new Response(body,{headers:{'Content-Type':'text/event-stream','Mcp-Session-Id':'session'}})}
  return new Response(JSON.stringify(payload),{headers:{'Content-Type':'application/json','Mcp-Session-Id':'session'}});
 };return {calls,fetchImpl,canceled:()=>canceled};
}
test('JSON probe is read-only, forwards private header/session, accepts 204 notification',async()=>{
 const f=fixture();const token='private-token-marker';const result=await checkMcp({url:'https://example.com/mcp',token,fetchImpl:f.fetchImpl});
 assert.deepEqual(result,{state:'connected',toolCount:1,toolNames:['safe_catalog_tool'],hasMore:false});assert.ok(!JSON.stringify(result).includes(token));
 assert.deepEqual(f.calls.map(c=>c.request.method),['initialize','notifications/initialized','tools/list']);
 for(const c of f.calls){assert.equal(c.options.redirect,'manual');assert.equal(c.options.headers.Authorization,`Bearer ${token}`);assert.ok(c.options.signal)}
 assert.equal(f.calls[2].options.headers['Mcp-Session-Id'],'session');
});
test('bounded SSE probe ignores unrelated IDs and cancels each stream immediately',async()=>{
 const f=fixture({sse:true,notification:202});assert.equal((await checkMcp({url:'http://localhost:1234/mcp',fetchImpl:f.fetchImpl})).state,'connected');assert.equal(f.canceled(),2);
});
test('authentication and redirect failures do not make tool calls',async()=>{
 for(const status of [401,403,302]){let count=0;const result=await checkMcp({url:'https://example.com/mcp',fetchImpl:async()=>{count++;return new Response(null,{status})}});assert.equal(result.state,status===302?'http_error':'authentication_required');assert.equal(count,1)}
});
test('credential-bearing and remote HTTP endpoints are rejected before network',async()=>{
 for(const url of ['https://user:secret@example.com/mcp','https://example.com/mcp?key=secret','https://example.com/mcp#secret','http://example.com/mcp'])await assert.rejects(checkMcp({url,fetchImpl:async()=>{throw Error('Network forbidden')}}));
});
test('wrong response ID, malformed JSON and oversized SSE are invalid protocol',async()=>{
 for(const body of ['{}','garbage',JSON.stringify({jsonrpc:'2.0',id:99,result:{}})])assert.equal((await checkMcp({url:'https://example.com/mcp',fetchImpl:async()=>new Response(body)})).state,'invalid_protocol');
 let canceled=false;const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(70000))},cancel(){canceled=true}});
 assert.equal((await checkMcp({url:'https://example.com/mcp',fetchImpl:async()=>new Response(stream,{headers:{'Content-Type':'text/event-stream'}})})).state,'invalid_protocol');assert.equal(canceled,true);
});

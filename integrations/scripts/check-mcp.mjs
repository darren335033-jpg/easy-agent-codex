// Read-only protocol probe. Makes no generation, provisioning or write tool calls.
export async function checkMcp({url,token,fetchImpl=fetch}={}){
 const endpoint=new URL(url);if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw Error('Use a credential-free MCP endpoint.');
 if(endpoint.protocol!=='https:'&&!(endpoint.protocol==='http:'&&['127.0.0.1','localhost'].includes(endpoint.hostname)))throw Error('MCP endpoint must use HTTPS or loopback.');
 const baseHeaders={'Content-Type':'application/json',Accept:'application/json, text/event-stream'};if(token)baseHeaders.Authorization=`Bearer ${token}`;
 let session;
 async function request(method,params,id){const headers={...baseHeaders};if(session)headers['Mcp-Session-Id']=session;if(method!=='initialize')headers['MCP-Protocol-Version']='2025-03-26';let response;try{response=await fetchImpl(endpoint.href,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',method,...(id?{id}:{}),...(params?{params}:{})}),redirect:'manual',signal:AbortSignal.timeout(15000)})}catch{return {state:'unreachable'}}
 if([401,403].includes(response.status))return {state:'authentication_required',httpStatus:response.status};if(!response.ok)return {state:'http_error',httpStatus:response.status};session=response.headers.get('mcp-session-id')||session;if([202,204].includes(response.status)&&id===undefined)return {state:'accepted'};
 let data;
 try{
  if((response.headers.get('content-type')||'').includes('text/event-stream')){
   if(!response.body)return {state:'invalid_protocol'};
   const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',bytes=0;
   try{
    while(!data){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>65536)return {state:'invalid_protocol'};pending+=decoder.decode(chunk.value,{stream:true}).replace(/\r\n/g,'\n');
     let boundary;while((boundary=pending.indexOf('\n\n'))!==-1){const event=pending.slice(0,boundary);pending=pending.slice(boundary+2);const payload=event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!payload)continue;let value;try{value=JSON.parse(payload)}catch{continue}if(value.id===id){data=value;break}}
    }
   }finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
  }else{
   if(!response.body)return {state:'invalid_protocol'};
   const reader=response.body.getReader(),decoder=new TextDecoder();let text='',bytes=0;
   try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>65536)return {state:'invalid_protocol'};text+=decoder.decode(chunk.value,{stream:true})}text+=decoder.decode()}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
   data=JSON.parse(text);
  }
 }catch{return {state:'invalid_protocol'}}
 if(!data||data.jsonrpc!=='2.0'||data.id!==id)return {state:'invalid_protocol'};
 if(data.error)return {state:'protocol_error'};return {state:'ok',data:data.result};}
 const initialized=await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'easy-agent-integration-check',version:'1.0'}},1);if(initialized.state!=='ok')return initialized;
 const notification=await request('notifications/initialized');if(!['ok','accepted'].includes(notification.state))return notification;
 const listed=await request('tools/list',{},2);if(listed.state!=='ok')return listed;
 const tools=listed.data?.tools;if(!Array.isArray(tools))return {state:'invalid_tool_catalog'};
 return {state:'connected',toolCount:tools.length,toolNames:tools.map(t=>t.name),hasMore:Boolean(listed.data.nextCursor)};
}
if(process.argv[1]?.endsWith('check-mcp.mjs')){const url=process.argv[2]??'http://127.0.0.1:20128/api/mcp/stream';const result=await checkMcp({url,token:process.env.OMNIROUTE_MCP_TOKEN});console.log(JSON.stringify(result));if(result.state!=='connected')process.exitCode=1;}

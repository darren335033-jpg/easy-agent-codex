import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
const fail=(status,message)=>Object.assign(new Error(message),{status});
export async function streamVideo(job,req,res,{env=process.env,fetchImpl=fetch,maxBytes=256*1024*1024}={}){
 if(job.status!=='succeeded'||!['veo','runway','seedance'].includes(job.provider))throw fail(409,'This job has no playable output.');
 let url;try{url=new URL(job.videoUrl)}catch{throw fail(502,'Invalid video location.');}
 const runwayHosts=(env.RUNWAY_MEDIA_HOSTS??'').split(',').map(h=>h.trim()).filter(h=>/^[a-z0-9-]+\.cloudfront\.net$/.test(h));
 const approved=job.provider==='veo'?['generativelanguage.googleapis.com','storage.googleapis.com'].includes(url.hostname):(url.hostname==='runwayml.com'||url.hostname.endsWith('.runwayml.com')||runwayHosts.includes(url.hostname));
 if(url.protocol!=='https:'||url.username||url.password||url.port||!approved||url.searchParams.has('key'))throw fail(502,'Video host is not approved.');
 const headers={};if(job.provider==='veo'&&url.hostname==='generativelanguage.googleapis.com'){if(!env.GEMINI_API_KEY)throw fail(503,'Video retrieval requires the configured provider credential.');headers['x-goog-api-key']=env.GEMINI_API_KEY;}
 if(req.headers.range){if(!/^bytes=\d+-\d*$/.test(req.headers.range))throw fail(416,'Unsupported video range.');headers.Range=req.headers.range;}
 let upstream;try{upstream=await fetchImpl(url.href,{headers,redirect:'manual',signal:AbortSignal.timeout(120000)})}catch{throw fail(502,'Video retrieval unavailable.');}
 if(![200,206].includes(upstream.status)||!upstream.body)throw fail(502,'Video retrieval unavailable.');
 const length=Number(upstream.headers.get('content-length')??0);if(length>maxBytes){await upstream.body.cancel();throw fail(502,'Video exceeds the local download limit.');}
 const type=upstream.headers.get('content-type')??'';if(!/^(video\/mp4|application\/octet-stream)(;|$)/i.test(type)){await upstream.body.cancel();throw fail(502,'Provider did not return video content.');}
 res.statusCode=upstream.status;res.setHeader('Content-Type','video/mp4');res.setHeader('Cache-Control','no-store');
 for(const name of ['content-length','content-range','accept-ranges']){const value=upstream.headers.get(name);if(value)res.setHeader(name,value);}
 let bytes=0;const limit=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;callback(bytes>maxBytes?new Error('Video limit exceeded'):null,chunk)}});
 try{await pipeline(Readable.fromWeb(upstream.body),limit,res)}catch{res.destroy();}
}

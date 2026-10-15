import { handleApi } from '../server/api.mjs';
import html from '../.forge/index.html';
import sourceZip from '../.forge/source.b64';
import assets from '../.forge/assets.json';
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(url.pathname.startsWith('/assets/')&&(request.method==='GET'||request.method==='HEAD')){
      const asset=assets[url.pathname.slice('/assets/'.length)];if(!asset)return new Response('Asset not found',{status:404});
      const bytes=Uint8Array.from(atob(asset.data),c=>c.charCodeAt(0));
      const headers={'Content-Type':asset.mime,'Cache-Control':'private, max-age=86400','ETag':'"'+asset.etag+'"','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes'};
      const range=request.headers.get('Range');
      if(range){const match=range.match(/^bytes=(\d+)-(\d*)$/);if(!match)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${bytes.length}`}});const start=Number(match[1]),end=match[2]?Math.min(Number(match[2]),bytes.length-1):bytes.length-1;if(start>end||start>=bytes.length)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${bytes.length}`}});headers['Content-Range']=`bytes ${start}-${end}/${bytes.length}`;headers['Content-Length']=String(end-start+1);return new Response(request.method==='HEAD'?null:bytes.slice(start,end+1),{status:206,headers});}
      headers['Content-Length']=String(bytes.length);return new Response(request.method==='HEAD'?null:bytes,{headers});
    }
    if(url.pathname==='/download/source.zip'&&request.method==='GET')return new Response(Uint8Array.from(atob(sourceZip),c=>c.charCodeAt(0)),{headers:{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="dazza-forge.zip"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
    if(url.pathname.startsWith('/api/'))return handleApi(request,env,{runtime:'cloud'});
    if(request.method!=='GET'&&request.method!=='HEAD')return new Response('Method not allowed',{status:405});
    return new Response(request.method==='HEAD'?null:html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Permissions-Policy':'camera=(), microphone=(), geolocation=()','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"}});
  }
};

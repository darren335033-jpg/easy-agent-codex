import { build } from 'esbuild';
import { mkdir, readFile, writeFile, rm, copyFile, readdir } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { sourceDirectoryAllowed, sourceFileAllowed } from './source-files.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');
await mkdir(path.join(root,'.forge'),{recursive:true});
const front=await build({entryPoints:[path.join(root,'src/main.jsx')],bundle:true,minify:true,format:'iife',target:['es2022'],write:false,outfile:path.join(root,'.forge/app.js'),legalComments:'none'});
const js=front.outputFiles.find(f=>f.path.endsWith('.js')).text;
const css=front.outputFiles.find(f=>f.path.endsWith('.css'))?.text||'';
const html='<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#151719"><meta name="description" content="Easy Agent AI — a coding workspace for Darren Smith. Real repositories, reviewed changes, isolated tests, and OpenAI, Vertex, or local models."><title>Easy Agent AI · Code Workspace</title><style>'+css.replace(/<\/style/gi,'<\\/style')+'</style></head><body><div id="root"></div><script>'+js.replace(/<\/script/gi,'<\\/script')+'</script></body></html>';
await writeFile(path.join(root,'.forge/index.html'),html);
const publicAssets={};
for(const [name,mime] of Object.entries({'founder-portrait.jpg':'image/jpeg','founder-brand-reference.jpg':'image/jpeg','media-thumbnail.jpg':'image/jpeg','mascot-studio.mp4':'video/mp4'})){
  const content=await readFile(path.join(root,'assets',name));
  publicAssets[name]={mime,data:content.toString('base64'),etag:createHash('sha256').update(content).digest('hex')};
}
await writeFile(path.join(root,'.forge/assets.json'),JSON.stringify(publicAssets));
const sourceFiles={};
async function collect(dir=''){
  for(const item of await readdir(path.join(root,dir),{withFileTypes:true})){
    const relative=path.posix.join(dir,item.name);
    if(item.isDirectory()&&sourceDirectoryAllowed(relative))await collect(relative);
    else if(item.isFile()&&sourceFileAllowed(relative))sourceFiles[`dazza-forge/${relative}`]=new Uint8Array(await readFile(path.join(root,relative)));
  }
}
await collect();
const sourceZip=zipSync(sourceFiles,{level:6});
await writeFile(path.join(root,'.forge/source.zip'),sourceZip);
await writeFile(path.join(root,'.forge/source.b64'),Buffer.from(sourceZip).toString('base64'));
await rm(path.join(root,'dist'),{recursive:true,force:true});
await mkdir(path.join(root,'dist/server'),{recursive:true});
await mkdir(path.join(root,'dist/.openai'),{recursive:true});
await build({entryPoints:[path.join(root,'worker/entry.mjs')],bundle:true,minify:true,format:'esm',platform:'browser',target:['es2022'],outfile:path.join(root,'dist/server/index.js'),loader:{'.html':'text','.b64':'text'},legalComments:'none'});
await copyFile(path.join(root,'.openai/hosting.json'),path.join(root,'dist/.openai/hosting.json'));
console.log('Built private Worker app with embedded frontend.');

import * as fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {appError} from './auth.mjs';
const validId=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
const states=new Set(['queued','running','completed','failed','cancelled','incomplete']);
const storeError=()=>appError('Saved run data is unavailable or invalid.',503,'STORE_UNAVAILABLE');
export function createRunStore(directory){
  const root=path.resolve(directory);const locks=new Map();
  if(root===path.parse(root).root)throw appError('Use a dedicated directory for coding run storage.',503,'STORE_UNAVAILABLE');
  async function ready(){
    let current=path.parse(root).root;
    for(const part of root.slice(current.length).split(path.sep)){
      current=path.join(current,part);let stat;
      try{stat=await fs.lstat(current);}catch(error){if(error.code!=='ENOENT')throw error;try{await fs.mkdir(current,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}stat=await fs.lstat(current);}
      if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(current)!==current)throw storeError();
    }
    await fs.chmod(root,0o700);
  }
  function target(id){if(!validId(id))throw appError('Invalid run ID.');return path.join(root,id+'.json');}
  function checked(record,id){if(!record||typeof record!=='object'||Array.isArray(record)||record.id!==id||!states.has(record.status)||typeof record.createdAt!=='string'||!Number.isFinite(Date.parse(record.createdAt)))throw storeError();return record;}
  async function get(id){await ready();let handle;try{handle=await fs.open(target(id),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const stat=await handle.stat();if(!stat.isFile()||stat.nlink>1||stat.size>8*1024*1024)throw storeError();let record;try{record=JSON.parse(await handle.readFile('utf8'));}catch{throw storeError();}return checked(record,id);}catch(e){if(e.code==='ENOENT')throw appError('Run not found.',404,'NOT_FOUND');if(e.code==='ELOOP')throw storeError();throw e;}finally{await handle?.close();}}
  async function save(record){checked(record,record?.id);const destination=target(record.id);await ready();const output=JSON.stringify(record);if(Buffer.byteLength(output)>8*1024*1024)throw appError('Run history exceeds storage limits.',503,'STORE_LIMIT');const temporary=path.join(root,'.'+randomUUID()+'.tmp');try{await fs.writeFile(temporary,output,{flag:'wx',mode:0o600});await fs.rename(temporary,destination);}finally{await fs.rm(temporary,{force:true});}return record;}
  async function update(id,patch){const previous=locks.get(id)||Promise.resolve();const operation=previous.catch(()=>{}).then(async()=>{const record=await get(id);const next=typeof patch==='function'?await patch(record):{...record,...patch};return save({...next,id,updatedAt:new Date().toISOString()});});locks.set(id,operation);try{return await operation;}finally{if(locks.get(id)===operation)locks.delete(id);}}
  async function names(){await ready();return (await fs.readdir(root)).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n));}
  async function list(){const records=[];for(const name of await names()){try{records.push(await get(name.slice(0,-5)));records.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));if(records.length>100)records.pop();}catch{}}return records;}
  async function recover(){for(const name of await names()){let record;try{record=await get(name.slice(0,-5));}catch{continue;}if(['queued','running'].includes(record.status))await update(record.id,{status:'failed',error:{code:'SERVER_RESTARTED',message:'The local server restarted before this run finished. No changes were applied automatically.'},finishedAt:new Date().toISOString()});}}
  return {get,save,update,list,recover};
}

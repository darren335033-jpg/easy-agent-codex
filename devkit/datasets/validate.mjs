#!/usr/bin/env node
import { stat, readFile } from 'node:fs/promises';
import { validateDatasets } from '../../server/datasets.mjs';
const args=process.argv.slice(2);
if(!args.length||args.length>2||args.includes('--help')){console.log('Usage: node devkit/datasets/validate.mjs TRAINING.jsonl [VALIDATION.jsonl]\nText-only Gemini JSONL structural validation, duplicate and held-out prompt leakage checks. Local limit: 16 MiB combined.');process.exit(args.includes('--help')?0:2);}
try {
  const maxBytes=16*1024*1024;let total=0;
  for(const file of args){const s=await stat(file);if(!s.isFile())throw new Error('Dataset inputs must be regular files.');total+=s.size;}
  if(total>maxBytes)throw new Error('Local validation limit is 16 MiB combined. Split or stream larger datasets with a dedicated data pipeline.');
  const [training,validation]=await Promise.all(args.map(file=>readFile(file,'utf8')));
  const result=validateDatasets({training,validation},{maxBytes,maxRows:100000});
  console.log(JSON.stringify(result,null,2));process.exitCode=result.valid?0:1;
}catch(error){console.error(error.code==='ENOENT'?'Dataset file not found.':error.message);process.exitCode=2;}

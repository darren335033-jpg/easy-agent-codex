import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDatasets} from '../server/datasets.mjs';
const row=(prompt='Write add',answer='def add(a,b): return a+b')=>JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]},{role:'model',parts:[{text:answer}]}]});
test('text-only JSONL preserves code, accepts model roles and returns only diagnostics',()=>{
 const result=validateDatasets({training:row(),validation:row('Write product','def multiply(a,b): return a*b')});
 assert.equal(result.valid,true);assert.equal(result.training.examples,1);assert.equal(result.validation.examples,1);
 assert.ok(!JSON.stringify(result).includes('def add'));
});
test('invalid JSON, assistant roles, multimodal parts and missing target answers are rejected',()=>{
 for(const training of ['null','{broken',JSON.stringify({contents:[{role:'user',parts:[{text:'a'}]},{role:'assistant',parts:[{text:'b'}]}]}),JSON.stringify({contents:[{role:'user',parts:[{fileData:{}}]},{role:'model',parts:[{text:'b'}]}]}),JSON.stringify({contents:[{role:'user',parts:[{text:'a'}]}]})])assert.equal(validateDatasets({training}).valid,false);
});
test('prompt leakage fails even with changed target and JSON key order',()=>{
 const result=validateDatasets({training:row('same','answer one'),validation:JSON.stringify({contents:[{parts:[{text:'same'}],role:'user'},{parts:[{text:'answer two'}],role:'model'}]})});
 assert.equal(result.valid,false);assert.equal(result.overlapCount,1);
});
test('changing a system instruction does not bypass held-out prompt leakage detection',()=>{
 const changed=JSON.parse(row('same','new target'));changed.systemInstruction={parts:[{text:'A different instruction'}]};
 assert.equal(validateDatasets({training:row('same'),validation:JSON.stringify(changed)}).overlapCount,1);
});
test('duplicates and small datasets produce warnings rather than inventing hard minimums',()=>{
 const result=validateDatasets({training:row()+'\n'+row()});assert.equal(result.valid,true);assert.equal(result.training.duplicates,1);assert.ok(result.issues.some(i=>i.message.includes('not a hard minimum')));
});
test('validation enforces bounded requests, valid input types and diagnostics without source echo',()=>{
 assert.equal(validateDatasets({training:'a'.repeat(100)},{maxBytes:99}).valid,false);
 assert.equal(validateDatasets({training:row(),validation:{}}).valid,false);
 assert.equal(validateDatasets({training:''}).valid,false);
 assert.equal(validateDatasets({training:row()+'\n'+row('two')},{maxRows:1}).valid,false);
});

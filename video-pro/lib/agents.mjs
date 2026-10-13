import {readFile} from 'node:fs/promises';
export async function createRegistry(path){
 const blueprint=JSON.parse(await readFile(path,'utf8'));
 const agents=blueprint.teams.flatMap(team=>Array.from({length:team.count},(_,i)=>({id:`${team.id}-${String(i+1).padStart(3,'0')}`,name:`${team.name} ${String(i+1).padStart(3,'0')}`,team:team.id,task:team.task,deliverable:team.deliverable,status:'assigned_not_running',tools:[],spendingLimitUsd:0,executionEnabled:false,scope:{workItemId:null,maxConcurrentWorkItems:1,externalActionsAllowed:false,requiresReview:true}})));
 if(agents.length!==1050||new Set(agents.map(a=>a.id)).size!==1050||!blueprint.pilotAgentIds.every(id=>agents.some(a=>a.id===id)))throw Error('Invalid agent registry blueprint.');
 return {schemaVersion:1,total:1050,runtimeEnabled:false,description:'Inactive role slots, not deployed workers.',pilotAgentIds:blueprint.pilotAgentIds,agents};
}

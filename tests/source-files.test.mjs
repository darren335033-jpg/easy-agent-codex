import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceFileAllowed,sourceDirectoryAllowed} from '../scripts/source-files.mjs';
test('source downloads include maintained code and fixtures but exclude credentials, private datasets, state and caches',()=>{
 for(const path of ['AGENTS.md','docs/legacy-windows-v1.1.md','.github/workflows/ci.yml','devkit/infra/.gitignore','src/ModelLab.jsx','server/datasets.mjs','devkit/tuning/submit.py','devkit/infra/main.tf','devkit/infra/tests/defaults.tftest.hcl','devkit/infra/.terraform.lock.hcl','devkit/infra/terraform.tfvars.example','devkit/datasets/example-training.jsonl','.env.example'])assert.equal(sourceFileAllowed(path),true,path);
 for(const path of ['docs/customer-secrets.md','.github/private.json','.github/workflows/secrets.env','credentials.json','server/credentials.json','devkit/service-account.json','devkit/infra/private.pem','devkit/infra/terraform.tfvars.json','devkit/infra/prod.tfvars','devkit/infra/prod.auto.tfvars.json','devkit/infra/terraform.tfstate.backup','devkit/.env.local','devkit/evaluation/results/output.json','devkit/datasets/customer-training.jsonl','devkit/.venv/a.py','devkit/tuning/__pycache__/submit.pyc'])assert.equal(sourceFileAllowed(path),false,path);
 for(const path of ['.git','node_modules','devkit/.venv','devkit/infra/.terraform','devkit/evaluation/results'])assert.equal(sourceDirectoryAllowed(path),false,path);
});

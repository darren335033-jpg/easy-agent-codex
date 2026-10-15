// Source downloads are a maintained allowlist, not an archive of the checkout.
const rootFiles=new Set(['README.md','AGENTS.md','docs/legacy-windows-v1.1.md','.github/workflows/ci.yml','devkit/infra/.gitignore','package.json','package-lock.json','.gitignore','.env.example','.openai/hosting.json','assets/founder-portrait.jpg','assets/founder-brand-reference.jpg','assets/media-thumbnail.jpg','assets/mascot-studio.mp4','assets/manifest.json']);
const kitFiles=new Set(['devkit/README.md','devkit/requirements.txt','devkit/.env.example','devkit/evaluation/Dockerfile','devkit/evaluation/smoke.jsonl','devkit/datasets/example-training.jsonl','devkit/datasets/example-validation.jsonl','devkit/infra/terraform.tfvars.example','devkit/infra/.terraform.lock.hcl']);
export function sourceDirectoryAllowed(relative){
  const parts=relative.split('/');
  if(parts.some(p=>['node_modules','.git','dist','.forge','__pycache__','.venv','.terraform','.pytest_cache','results'].includes(p)))return false;
  if(['src','server','worker','scripts','tests','.openai','.github','docs','assets','examples'].includes(parts[0]))return true;
  return parts[0]==='devkit'&&(parts.length===1||['datasets','tuning','evaluation','infra','tests','ci','runner'].includes(parts[1]));
}
export function sourceFileAllowed(relative){
  if(rootFiles.has(relative)||kitFiles.has(relative))return true;
  if(relative==='devkit/runner/Dockerfile')return true;
  if(!sourceDirectoryAllowed(relative))return false;
  if(/(^|\/)(?:credentials|service[-_]?account|application_default_credentials|kubeconfig|id_rsa|id_ed25519)(?:[./_-]|$)/i.test(relative))return false;
  if(/\.(?:tfvars(?:\.json)?|tfstate(?:\..*)?|tfplan|pem|key|p12|pfx|jks)$/i.test(relative))return false;
  if(/(^|\/)\.env(?:\.|$)/.test(relative))return false;
  if(/^(src|server|worker|scripts|tests)\//.test(relative))return /\.(?:jsx?|mjs|css|tsx?)$/.test(relative);
  if(relative.startsWith('devkit/infra/'))return /\.(?:tf|tftest\.hcl)$/.test(relative)||relative.endsWith('/README.md');
  if(relative==='devkit/ci/check.sh')return true;
  if(relative.startsWith('devkit/'))return /\.(?:py|mjs)$/.test(relative)||relative.endsWith('/README.md');
  if(relative.startsWith('examples/'))return /\.(?:py|mjs|js)$/.test(relative)||relative.endsWith('/README.md');
  return false;
}

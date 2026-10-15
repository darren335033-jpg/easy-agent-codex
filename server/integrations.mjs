import {appError,googleToken} from './auth.mjs';
import {providerStatus} from './providers.mjs';
import {getGithubStatus,executeGithubRead} from './github.mjs';
import {testMcpConnection} from './mcp.mjs';

export const GITHUB_PROFILES=[{id:'profile',label:'Account profile'},{id:'repositories',label:'Repositories'},{id:'pulls',label:'Open pull requests'},{id:'issues',label:'Open issues'},{id:'runs',label:'Workflow runs'}];
export const CLI_PROFILES={github:[{id:'github.repos',label:'Repositories'},{id:'github.pulls',label:'Pull requests'},{id:'github.issues',label:'Issues'},{id:'github.runs',label:'Workflow runs'}],google:[{id:'google.projects',label:'Projects'},{id:'google.services',label:'Enabled APIs'},{id:'google.runServices',label:'Cloud Run services'},{id:'google.vertexModels',label:'Vertex models'}],huggingface:[{id:'huggingface.whoami',label:'Account identity'},{id:'huggingface.models',label:'Models'},{id:'huggingface.spaces',label:'Spaces'}]};

// Only documented endpoints belong here. Custom installations are server-owned.
export const PROVIDERS=[
  {id:'github',name:'GitHub',kind:'mcp',endpoint:'https://api.githubcopilot.com/mcp/',tokenEnv:'GITHUB_TOKEN',auth:'bearer',verified:true,docsUrl:'https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server'},
  {id:'google-vertex',name:'Google Vertex AI',kind:'mcp',endpoint:'https://aiplatform.googleapis.com/mcp/generate',tokenEnv:'GOOGLE_ACCESS_TOKEN',auth:'google',verified:true,docsUrl:'https://cloud.google.com/vertex-ai/docs'},
  {id:'cloudflare',name:'Cloudflare',kind:'mcp',endpoint:'https://mcp.cloudflare.com/mcp',endpointEnv:'CLOUDFLARE_MCP_URL',tokenEnv:'CLOUDFLARE_MCP_TOKEN',auth:'oauth',verified:true,docsUrl:'https://github.com/cloudflare/mcp'},
  {id:'sentry',name:'Sentry',kind:'mcp',endpoint:'https://mcp.sentry.dev/mcp',endpointEnv:'SENTRY_MCP_URL',tokenEnv:'SENTRY_MCP_TOKEN',auth:'oauth',verified:true,docsUrl:'https://github.com/getsentry/sentry-mcp'},
  {id:'huggingface',name:'Hugging Face',kind:'mcp',endpoint:'https://huggingface.co/mcp',endpointEnv:'HUGGINGFACE_MCP_URL',tokenEnv:'HF_TOKEN',auth:'none',verified:true,docsUrl:'https://huggingface.co/docs/hub/agents-mcp'},
  {id:'aweber',name:'AWeber',kind:'oauth',endpoint:'https://mcp.aweber.com/mcp',endpointEnv:'AWEBER_MCP_URL',tokenEnv:'AWEBER_MCP_TOKEN',auth:'oauth',verified:true,docsUrl:'https://docs.aweber.com/api/api/connecting-and-using-the-aweber-mcp-server'},
  {id:'getresponse',name:'GetResponse',kind:'oauth',endpoint:'https://mcp.getresponse.com',endpointEnv:'GETRESPONSE_MCP_URL',tokenEnv:'GETRESPONSE_MCP_TOKEN',auth:'oauth',verified:true,docsUrl:'https://www.getresponse.com/help/how-to-connect-getresponse-mcp-to-your-ai-application.html'},
  {id:'reddit',name:'Reddit',kind:'custom',endpointEnv:'REDDIT_MCP_URL',tokenEnv:'REDDIT_MCP_TOKEN',auth:'custom',verified:false,docsUrl:'https://www.reddit.com/dev/api/'},
  {id:'nvidia',name:'NVIDIA',kind:'custom',endpointEnv:'NVIDIA_MCP_URL',tokenEnv:'NVIDIA_MCP_TOKEN',auth:'custom',verified:false,docsUrl:'https://docs.nvidia.com/nemo/agent-toolkit/latest/run-workflows/mcp-server.html'},
  {id:'orca',name:'Orca',kind:'custom',endpointEnv:'ORCA_MCP_URL',tokenEnv:'ORCA_MCP_TOKEN',auth:'custom',verified:false},
  {id:'sandcastles',name:'Sandcastles',kind:'oauth',endpoint:'https://mcp.sandcastles.ai/',endpointEnv:'SANDCASTLES_MCP_URL',tokenEnv:'SANDCASTLES_MCP_TOKEN',auth:'oauth',verified:true,docsUrl:'https://help.sandcastles.ai/mcp'},
  {id:'omniroute',name:'OmniRoute',kind:'custom',endpointEnv:'OMNIROUTE_MCP_URL',tokenEnv:'OMNIROUTE_MCP_TOKEN',auth:'custom',verified:false},
  {id:'agent-os',name:'Agent OS',kind:'custom',endpointEnv:'AGENT_OS_MCP_URL',tokenEnv:'AGENT_OS_MCP_TOKEN',auth:'custom',verified:false},
  {id:'easy-agent',name:'Easy Agent MCP',kind:'custom',endpointEnv:'EASY_AGENT_MCP_URL',tokenEnv:'EASY_AGENT_MCP_TOKEN',auth:'custom',verified:false}
];

function publicEndpoint(value){
  if(!value)return null;
  let url;try{url=new URL(value);}catch{return null;}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search)return null;
  return url.href;
}
export function integrationCatalog(env={},options={}){
  return {providers:PROVIDERS.map(provider=>{
    const endpoint=publicEndpoint(provider.endpointEnv&&env[provider.endpointEnv]||provider.endpoint);
    const credential=provider.id==='github'?!!(env.GITHUB_TOKEN||env.GH_TOKEN):provider.auth==='google'?!!(env.GOOGLE_ACCESS_TOKEN||env.GOOGLE_SERVICE_ACCOUNT_JSON||options.hasADC):!!env[provider.tokenEnv];
    const connected=options.oauthConnected?.has(provider.id)||false;
    const canAuthorize=!!env.OAUTH_SESSION_SECRET&&endpoint===publicEndpoint(provider.endpoint)&&['aweber','getresponse','sandcastles'].includes(provider.id);
    const status=!endpoint?'needs_endpoint':connected?'connected':credential||provider.auth==='none'?'configured':provider.auth==='oauth'?'oauth_setup_required':'unconfigured';
    const reason=!endpoint?'Supply this service’s verified HTTPS MCP endpoint in server configuration.':connected?'Your OAuth account is authorized. Test MCP access to discover its available tools.':credential?'Server credentials are configured. Test the connection to verify access.':provider.auth==='none'?'Public MCP discovery is available. Sign in with the provider to access private resources.':canAuthorize?'Connect your account with OAuth, then test MCP access.':provider.auth==='oauth'?'Authorize this service using its supported OAuth MCP client, then configure the server connection.':provider.auth==='google'?'Google credentials and project access are required.':'A server-side credential is required to verify access.';
    return {...provider,endpoint,verified:!!provider.verified&&endpoint===publicEndpoint(provider.endpoint),status,configured:!!endpoint&&(credential||provider.auth==='none'),connected,canAuthorize,reason};
  })};
}
export async function integrationStatus(env={},options={}){
  const runtime=options.runtime||'cloud';
  const unavailable={installed:false,authenticated:false,reason:'CLI commands run in the local companion. Open the downloaded app on the machine with your CLI installations.'};
  const [mcp,cli]=await Promise.all([
    getGithubStatus(env,{fetch:options.fetch,signal:options.signal}).catch(()=>({configured:!!(env.GITHUB_TOKEN||env.GH_TOKEN),connected:false,reason:'GitHub MCP could not be verified. Check the server credential and network access.'})),
    ['local','hybrid'].includes(runtime)&&typeof options.cliStatus==='function'?options.cliStatus():Promise.resolve({github:unavailable,google:unavailable,huggingface:unavailable})
  ]);
  return {runtime,github:{mcp,cli:cli.github},google:{cli:cli.google,vertex:providerStatus(env,runtime,options.hasADC).vertex},huggingface:{cli:cli.huggingface||unavailable},profiles:{...CLI_PROFILES,github:GITHUB_PROFILES,cli:CLI_PROFILES}};
}
export async function integrationGithubRead(input,env={},options={}){
  return executeGithubRead(input,env,{fetch:options.fetch,signal:options.signal});
}
export async function integrationTest(input,env={},options={}){
  if(!input||Object.keys(input).some(key=>key!=='providerId')||typeof input.providerId!=='string')throw appError('Choose a configured provider.');
  const provider=PROVIDERS.find(item=>item.id===input.providerId);if(!provider)throw appError('Unknown integration provider.');
  if(provider.id==='github')return getGithubStatus(env,{fetch:options.fetch,signal:options.signal});
  const entry=integrationCatalog(env,options).providers.find(item=>item.id===provider.id);
  if(!entry.endpoint)throw appError('Set the verified MCP endpoint on the server before testing this service.',503,'MCP_ENDPOINT_REQUIRED');
  let token=provider.auth==='google'&&(env.GOOGLE_ACCESS_TOKEN||env.GOOGLE_SERVICE_ACCOUNT_JSON||options.hasADC)?await googleToken(env,options):env[provider.tokenEnv];
  if(provider.auth!=='none'&&!token)throw appError(entry.reason,503,'MCP_AUTH_REQUIRED');
  const defaultHost=provider.verified&&provider.endpoint?new URL(provider.endpoint).hostname:null;
  const allowedHosts=[defaultHost,...(env.MCP_ALLOWED_HOSTS||'').split(',').map(s=>s.trim())].filter(Boolean);
  const result=await testMcpConnection({url:entry.endpoint,token},{allowedHosts,fetch:options.fetch});
  return {...result,providerId:provider.id,executionAuthorized:false,note:'Connection and tool discovery were tested. No provider tool was executed.'};
}

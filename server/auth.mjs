const encoder = new TextEncoder();
const cache = new Map();
export function appError(message, status=400, code='INVALID_REQUEST') {
  return Object.assign(new Error(message), { status, code });
}
function b64url(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value);
  let binary=''; for(const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export async function googleToken(env, options={}) {
  if(env.GOOGLE_ACCESS_TOKEN) return env.GOOGLE_ACCESS_TOKEN;
  if(options.tokenProvider) return options.tokenProvider();
  if(!env.GOOGLE_SERVICE_ACCOUNT_JSON) throw appError('Connect Google Cloud credentials on the server to run Vertex AI. Local mode can use Google Application Default Credentials.',503,'PROVIDER_NOT_CONFIGURED');
  let account;
  try { account=JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON); } catch { throw appError('The server Google service account configuration is invalid.',503,'PROVIDER_NOT_CONFIGURED'); }
  if(!account.client_email || !account.private_key) throw appError('Google service account email and private key are required.',503,'PROVIDER_NOT_CONFIGURED');
  const existing=cache.get(account.client_email);
  if(existing && existing.expires>Date.now()+60000) return existing.token;
  const now=Math.floor(Date.now()/1000);
  const head=b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const body=b64url(JSON.stringify({iss:account.client_email,scope:'https://www.googleapis.com/auth/cloud-platform',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}));
  let signature;
  try { const der=Uint8Array.from(atob(account.private_key.replace(/-----[^-]+-----|\s/g,'')),c=>c.charCodeAt(0));const key=await crypto.subtle.importKey('pkcs8',der,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']); signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,encoder.encode(`${head}.${body}`)); }
  catch { throw appError('Unable to load the server service account private key.',503,'PROVIDER_NOT_CONFIGURED'); }
  const response=await (options.fetch||globalThis.fetch.bind(globalThis))('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:`${head}.${body}.${b64url(signature)}`}),redirect:'manual',signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw appError('Google authentication failed. Check the server service account and IAM permissions.',401,'AUTH_FAILED');
  const result=await response.json();
  if(!result.access_token) throw appError('Google did not return an access token.',502,'AUTH_FAILED');
  cache.set(account.client_email,{token:result.access_token,expires:Date.now()+Number(result.expires_in||3600)*1000});
  return result.access_token;
}

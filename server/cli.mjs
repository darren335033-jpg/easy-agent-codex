import { execFile as nodeExecFile } from 'node:child_process';
import path from 'node:path';

const TIMEOUT_MS = 20_000;
const MAX_BUFFER = 256 * 1024;
const PROFILES = new Set(['github.repos', 'github.pulls', 'github.issues', 'github.runs', 'google.projects', 'google.services', 'google.runServices', 'google.vertexModels', 'huggingface.whoami', 'huggingface.models', 'huggingface.spaces']);
const error = (message, status = 400, code = 'INVALID_CLI_REQUEST') => Object.assign(new Error(message), { status, code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const githubIdentityPattern = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$/;
const repositoryPattern = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/;
const projectPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const regionPattern = /^[a-z]+(?:-[a-z0-9]+)+[0-9]$/;

function sanitizeEnvironment(source, provider) {
  const names = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']);
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    if (names.has(key) || (provider === 'github' && ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR'].includes(key)) || (provider === 'google' && key.startsWith('CLOUDSDK_')) || (provider === 'huggingface' && ['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'HF_HOME', 'HF_TOKEN_PATH', 'HF_ENDPOINT', 'HF_HUB_OFFLINE', 'HF_HUB_DISABLE_IMPLICIT_TOKEN'].includes(key))) env[key] = value;
  }
  Object.assign(env, { NO_COLOR: '1', CLICOLOR: '0', TERM: 'dumb', PAGER: 'cat' });
  if (provider === 'github') Object.assign(env, { GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', GH_DEBUG: '' });
  else if (provider === 'google') Object.assign(env, { CLOUDSDK_CORE_DISABLE_PROMPTS: '1', CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: '1', CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: '1', CLOUDSDK_CORE_LOG_HTTP: 'false', CLOUDSDK_CORE_VERBOSITY: 'error', CLOUDSDK_CORE_DISABLE_FILE_LOGGING: 'true' });
  else Object.assign(env, { HF_HUB_DISABLE_PROGRESS_BARS: '1', HF_HUB_DISABLE_TELEMETRY: '1' });
  return env;
}

function scrubber(env) {
  const sensitive = Object.entries(env).filter(([key, value]) => /TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL|SERVICE_ACCOUNT_JSON|API_KEY/.test(key) && typeof value === 'string' && value.length >= 6).map(([, value]) => value).sort((a, b) => b.length - a.length);
  return text => {
    let output = String(text);
    for (const value of sensitive) output = output.split(value).join('[REDACTED]');
    return output
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]')
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|hf_[A-Za-z0-9]{20,}|ya29\.[A-Za-z0-9._-]+|AIza[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,})\b/g, '[REDACTED]')
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{8,}/gi, '[REDACTED]');
  };
}

function scrubData(value, scrub, depth = 0) {
  if (depth > 30) return '[Nested data omitted]';
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(item => scrubData(item, scrub, depth + 1));
  if (object(value)) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:token|secret|password|private[_-]?key|authorization|credential)/i.test(key)).map(([key, item]) => [scrub(key), scrubData(item, scrub, depth + 1)]));
  }
  return value;
}

/** Fixed, read-only CLI profiles. No browser-supplied executable, cwd, or argument list. */
export function createCliService({ env = process.env, workspace, execFile = nodeExecFile } = {}) {
  if (!object(env) || typeof execFile !== 'function') throw error('CLI configuration is invalid.');
  if (workspace !== undefined && (typeof workspace !== 'string' || !path.isAbsolute(workspace) || workspace.includes('\0'))) throw error('CLI workspace must be a configured absolute directory.');
  const cwd = workspace || process.cwd();
  const settings = { ...env };
  const binaries = { github: settings.GH_BIN || 'gh', google: settings.GCLOUD_BIN || 'gcloud', huggingface: settings.HF_BIN || 'hf' };
  for (const binary of Object.values(binaries)) {
    if (typeof binary !== 'string' || !binary || binary.includes('\0') || binary.length > 4096) throw error('CLI executable configuration is invalid.');
  }
  const scrub = scrubber(settings);
  let active = 0;

  async function execute(provider, args) {
    if (active >= 2) throw error('Two CLI requests are already running. Wait before retrying.', 429, 'CLI_BUSY');
    active++;
    try {
      return await new Promise(resolve => {
        const finish = (failure, stdout = '', _stderr = '') => {
          const oversized = failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || Buffer.byteLength(String(stdout)) > MAX_BUFFER;
          const timedOut = !!failure?.killed || failure?.signal === 'SIGKILL';
          const missing = failure?.code === 'ENOENT' || failure?.code === 'EACCES';
          const exitCode = oversized || timedOut ? 124 : missing ? 127 : Number.isInteger(failure?.code) ? failure.code : failure ? 1 : 0;
          resolve({ exitCode, stdout: failure || oversized ? '' : String(stdout), missing, timedOut, oversized });
        };
        try {
          execFile(binaries[provider], args, { cwd, env: sanitizeEnvironment(settings, provider), timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8', windowsHide: true, shell: false, killSignal: 'SIGKILL' }, finish);
        } catch (failure) { finish(failure); }
      });
    } finally { active--; }
  }

  function failedOutput(result, provider) {
    const label = provider === 'github' ? 'GitHub CLI' : provider === 'google' ? 'Google Cloud CLI' : 'Hugging Face CLI';
    if (result.missing) return `${label} is unavailable. Install it or configure its server-side executable path.`;
    if (result.oversized) return `${label} output exceeded the 256 KiB limit. Narrow the selected profile or project.`;
    if (result.timedOut) return `${label} exceeded the 20-second deadline.`;
    return `${label} could not complete this read-only request. Check authentication, access permissions, and network connectivity.`;
  }

  async function githubStatus() {
    const version = await execute('github', ['--version']);
    if (version.exitCode !== 0) return { installed: !version.missing, authenticated: false, version: null, reason: failedOutput(version, 'github') };
    const match = /^gh version ([A-Za-z0-9.+_-]{1,80})\b/m.exec(scrub(version.stdout));
    const auth = await execute('github', ['api', 'user', '--jq', '.login']);
    const login = scrub(auth.stdout.trim());
    const authenticated = auth.exitCode === 0 && githubIdentityPattern.test(login);
    return { installed: true, authenticated, version: match?.[1] || 'unknown', ...(authenticated ? { login } : {}), reason: authenticated ? 'Authenticated GitHub API access verified for this server identity.' : 'GitHub authentication is unavailable. Authenticate gh on the server or configure its token securely.' };
  }

  async function googleStatus() {
    const version = await execute('google', ['version', '--format=json']);
    if (version.exitCode !== 0) return { installed: !version.missing, authenticated: false, version: null, reason: failedOutput(version, 'google') };
    let versionText = 'unknown';
    try { const parsed = JSON.parse(version.stdout); if (/^[0-9][A-Za-z0-9.+_-]{0,79}$/.test(scrub(parsed['Google Cloud SDK']))) versionText = scrub(parsed['Google Cloud SDK']); } catch {}
    const auth = await execute('google', ['auth', 'list', '--filter=status:ACTIVE', '--format=json(status)']);
    let authenticated = false;
    try { const accounts = JSON.parse(auth.stdout); authenticated = auth.exitCode === 0 && Array.isArray(accounts) && accounts.some(account => account?.status === 'ACTIVE'); } catch {}
    let projectId = settings.GOOGLE_CLOUD_PROJECT || settings.CLOUDSDK_CORE_PROJECT;
    if (!projectId || !projectPattern.test(projectId)) {
      const project = await execute('google', ['config', 'get-value', 'project', '--quiet']);
      if (project.exitCode === 0 && projectPattern.test(project.stdout.trim())) projectId = project.stdout.trim();
      else projectId = undefined;
    }
    return { installed: true, authenticated, version: versionText, ...(projectId ? { projectId } : {}), reason: authenticated ? 'An active gcloud CLI identity is configured; individual project permissions are checked by each request.' : 'No active gcloud CLI account is configured. Authenticate the CLI on the server. Application Default Credentials are configured separately.' };
  }

  function huggingfaceIdentity(stdout) {
    const data = JSON.parse(stdout);
    const login = scrub(data?.name || data?.username || data?.login || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(login)) throw error('Hugging Face did not provide a valid identity.', 502, 'CLI_RESPONSE_INVALID');
    const organizations = Array.isArray(data.orgs) ? data.orgs.map(org => scrub(typeof org === 'string' ? org : org?.name || '')).filter(name => /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(name)).slice(0,100) : [];
    return { login, organizations };
  }

  async function huggingfaceStatus() {
    const version = await execute('huggingface', ['version', '--format', 'json']);
    if (version.exitCode !== 0) return { installed: !version.missing, authenticated: false, version: null, reason: failedOutput(version, 'huggingface') };
    let versionText = 'unknown';
    try { const parsed = JSON.parse(version.stdout); if (/^[0-9][A-Za-z0-9.+_-]{0,79}$/.test(scrub(parsed?.version))) versionText = scrub(parsed.version); }
    catch { const match = /^(?:version=)?([0-9][A-Za-z0-9.+_-]{0,79})\s*$/m.exec(scrub(version.stdout)); if (match) versionText = match[1]; }
    const auth = await execute('huggingface', ['auth', 'whoami', '--format', 'json']);
    let identity;
    if (auth.exitCode === 0) { try { identity = huggingfaceIdentity(auth.stdout); } catch {} }
    return { installed: true, authenticated: !!identity, version: versionText, ...(identity ? { login: identity.login } : {}), reason: identity ? 'Authenticated Hugging Face Hub identity verified.' : 'No authenticated Hugging Face identity is available. Public model and Space lists can still work without login.' };
  }

  function profileArgs(input) {
    if (!object(input) || Object.keys(input).some(key => !['profile', 'repository', 'projectId', 'region'].includes(key)) || !PROFILES.has(input.profile)) throw error('Choose a supported read-only GitHub or Google Cloud CLI profile.');
    for (const field of ['repository', 'projectId', 'region']) if (input[field] !== undefined && typeof input[field] !== 'string') throw error(`${field} must be a string.`);
    const provider = input.profile.split('.')[0];
    const repository = input.repository || settings.GH_REPO || settings.GITHUB_REPOSITORY;
    const projectId = input.projectId || settings.GOOGLE_CLOUD_PROJECT || settings.CLOUDSDK_CORE_PROJECT;
    const region = input.region || settings.GOOGLE_CLOUD_REGION || settings.GOOGLE_CLOUD_LOCATION || settings.CLOUDSDK_COMPUTE_REGION || 'us-central1';
    if (input.repository && (!repositoryPattern.test(input.repository) || ['.', '..'].includes(input.repository.split('/')[1]))) throw error('Enter a GitHub repository as owner/name.');
    if (input.projectId && !projectPattern.test(input.projectId)) throw error('Enter a valid Google Cloud project ID.');
    if (input.region && (input.region.length > 40 || !regionPattern.test(input.region))) throw error('Enter a regional Google Cloud location such as us-central1.');
    let args;
    if (input.profile === 'github.repos') {
      const owner = input.repository ? input.repository.split('/')[0] : undefined;
      args = ['repo', 'list', ...(owner ? [owner] : []), '--limit', '50', '--json', 'nameWithOwner,description,isPrivate,url,updatedAt,defaultBranchRef'];
    } else if (provider === 'github') {
      if (typeof repository !== 'string' || !repositoryPattern.test(repository) || ['.', '..'].includes(repository.split('/')[1])) throw error('Select a GitHub repository as owner/name, or configure GH_REPO.');
      if (input.profile === 'github.pulls') args = ['pr', 'list', '--repo', repository, '--limit', '50', '--state', 'open', '--json', 'number,title,state,url,headRefName,baseRefName,updatedAt'];
      else if (input.profile === 'github.issues') args = ['issue', 'list', '--repo', repository, '--limit', '50', '--state', 'open', '--json', 'number,title,state,url,updatedAt,labels'];
      else args = ['run', 'list', '--repo', repository, '--limit', '50', '--json', 'databaseId,displayTitle,status,conclusion,url,headBranch,createdAt'];
    } else if (provider === 'huggingface') {
      if (input.profile === 'huggingface.whoami') args = ['auth', 'whoami', '--format', 'json'];
      else if (input.profile === 'huggingface.models') args = ['models', 'ls', '--limit', '50', '--sort', 'downloads', '--expand=author,downloads,likes,pipeline_tag', '--format', 'json'];
      else args = ['spaces', 'ls', '--limit', '50', '--sort', 'likes', '--expand=author,likes,sdk,private', '--format', 'json'];
    } else if (input.profile === 'google.projects') args = ['projects', 'list', '--limit=100', '--format=json(projectId,name,lifecycleState)'];
    else {
      if (typeof projectId !== 'string' || !projectPattern.test(projectId)) throw error('Select a Google Cloud project ID, or configure GOOGLE_CLOUD_PROJECT.');
      if (input.profile === 'google.services') args = ['services', 'list', '--enabled', `--project=${projectId}`, '--limit=100', '--format=json(config.name,config.title,state)'];
      else {
        if (typeof region !== 'string' || region.length > 40 || !regionPattern.test(region)) throw error('Choose a regional Google Cloud location such as us-central1.');
        if (input.profile === 'google.runServices') args = ['run', 'services', 'list', `--project=${projectId}`, `--region=${region}`, '--platform=managed', '--limit=100', '--format=json(metadata.name,status.url,status.conditions,metadata.creationTimestamp)'];
        else args = ['ai', 'models', 'list', `--project=${projectId}`, `--region=${region}`, '--limit=100', '--format=json(name,displayName,createTime,updateTime)'];
      }
    }
    return { provider, args };
  }

  return {
    async status() {
      const [github, google] = await Promise.all([githubStatus(), googleStatus()]);
      const huggingface = await huggingfaceStatus();
      return { github, google, huggingface };
    },
    async run(input) {
      const { provider, args } = profileArgs(input);
      const started = performance.now();
      const result = await execute(provider, args);
      const base = { profile: input.profile, command: scrub(`${provider === 'github' ? 'gh' : provider === 'google' ? 'gcloud' : 'hf'} ${args.join(' ')}`), exitCode: result.exitCode, durationMs: Math.round(performance.now() - started) };
      if (result.exitCode !== 0) return { ...base, output: failedOutput(result, provider) };
      let data;
      try { data = input.profile === 'huggingface.whoami' ? huggingfaceIdentity(result.stdout) : scrubData(JSON.parse(result.stdout), scrub); }
      catch { return { ...base, exitCode: 1, output: 'CLI returned an unreadable JSON response. No raw output was exposed.' }; }
      return { ...base, output: JSON.stringify(data, null, 2), data };
    },
  };
}

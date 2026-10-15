import path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRepositoryService } from '../server/repository.mjs';

const exec = promisify(execFile);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureFiles = ['calculator.py', 'test_calculator.py', 'README.md'];

async function statIfPresent(target) {
  try { return await fs.lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function safeDirectory(target, { create = false } = {}) {
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    let stat = await statIfPresent(current);
    if (!stat && create && current === target) { await fs.mkdir(current, { mode: 0o700 }); stat = await fs.lstat(current); }
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Demo directory must exist without symlink components: ${target}`);
  }
}

export async function prepareDemo(root = appRoot) {
  const stateRoot = path.join(root, '.forge');
  const demoRoot = path.join(stateRoot, 'demo');
  await safeDirectory(stateRoot, { create: true });
  const existing = await statIfPresent(demoRoot);
  if (existing) {
    await safeDirectory(demoRoot);
    const info = await createRepositoryService(demoRoot).info();
    if (!info.isRepository) throw new Error('Existing .forge/demo is not a Git repository. It was left untouched.');
    return { root: demoRoot, created: false };
  }
  const staging = await fs.mkdtemp(path.join(stateRoot, 'demo-bootstrap-'));
  try {
    await fs.chmod(staging, 0o700);
    for (const name of fixtureFiles) {
      const source = path.join(root, 'examples', 'starter', name);
      const stat = await fs.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Demo fixture must be a regular file: ${name}`);
      await fs.copyFile(source, path.join(staging, name));
    }
    const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(gitEnv, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' });
    const git = async args => exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', '-c', 'init.templateDir=', ...args], { cwd: staging, env: gitEnv, timeout: 15_000, maxBuffer: 128_000 });
    await git(['init', '--quiet', '--initial-branch=main']);
    await git(['config', '--local', 'user.name', 'Easy Agent AI Demo']);
    await git(['config', '--local', 'user.email', 'demo@easyagent.local']);
    await git(['add', '--', ...fixtureFiles]);
    await git(['commit', '--quiet', '--no-gpg-sign', '--no-verify', '-m', 'Add intentional calculator bug and regression tests']);
    if (await statIfPresent(demoRoot)) throw new Error('.forge/demo appeared during setup and was left untouched.');
    await fs.rename(staging, demoRoot);
    return { root: demoRoot, created: true };
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--prepare-only')) throw new Error('Usage: npm run demo [-- --prepare-only]');
  try { process.loadEnvFile(path.join(appRoot, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const demo = await prepareDemo();
  console.log(`${demo.created ? 'Created' : 'Reusing'} persistent demo repository: ${demo.root}`);
  console.log('Demo setup does not install models or run AI requests or generated-code tests.');
  if (args.includes('--prepare-only')) return;
  const env = { ...process.env, FORGE_WORKSPACE: demo.root, FORGE_STATE_DIR: process.env.FORGE_STATE_DIR || path.join(appRoot, '.forge', 'demo-runs') };
  let active;
  let stopping = false;
  const onSignal = signal => { stopping = true; active?.kill(signal); };
  const interrupt = () => onSignal('SIGINT');
  const terminate = () => onSignal('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  async function run(script) {
    return new Promise((resolve, reject) => {
      active = spawn(process.execPath, [path.join(appRoot, script)], { cwd: appRoot, env, stdio: 'inherit' });
      active.once('error', reject);
      active.once('exit', (code, signal) => { active = undefined; if (signal && stopping) resolve(0); else if (code === 0) resolve(0); else reject(new Error(`${script} exited ${signal || code}.`)); });
    });
  }
  try {
    await run('scripts/build.mjs');
    if (stopping) return;
    console.log(`Open http://127.0.0.1:${env.PORT || 3000}. Use the Python test profile for the calculator fixture.`);
    await run('server/local.mjs');
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Demo setup failed: ${error.message}`); process.exitCode = 1; });
}

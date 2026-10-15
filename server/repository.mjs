import path from 'node:path';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MAX_FILE_BYTES = 1_000_000;
const MAX_TREE_FILES = 2000;
const locks = new Map();
const hash = content => createHash('sha256').update(content).digest('hex');
function failure(message, status = 400, code = 'REPOSITORY_INVALID') {
  return Object.assign(new Error(message), { status, code });
}
export function allowedPath(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || /[\x00-\x1f\x7f\\:]/.test(value) || path.posix.isAbsolute(value)) return false;
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return false;
  return parts.every(part => {
    const name = part.toLowerCase();
    const example = /\.(example|sample|template)(\.[a-z0-9]+)?$/.test(name);
    if (['.git', '.ssh', '.aws', '.azure', '.config', '.docker', '.kube', '.gnupg', '.cache', '.venv', 'venv', 'node_modules', '__pycache__', '.next', '.nuxt', '.terraform', '.forge'].includes(name) || name.startsWith('.forge-txn-')) return false;
    if (/^(\.npmrc|\.pypirc|\.netrc|\.gitconfig|\.git-credentials|\.bash_history|\.zsh_history|\.bashrc|\.zshrc|\.profile)$/.test(name)) return false;
    if (name.startsWith('.env') && !example) return false;
    if (!example && (/(^|[-_.])(credentials?|secrets?|private[-_]?keys?)([-_.]|$)/.test(name) || /service[-_]?account|application_default_credentials|kubeconfig/.test(name))) return false;
    if (!example && (/^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/.test(name) || /\.(pem|key|p12|pfx|jks|keystore|tfstate|tfvars)(\.|$)/.test(name))) return false;
    return true;
  });
}
function validatePath(value) {
  if (!allowedPath(value)) throw failure('A file path is outside the workspace or is excluded because it may contain credentials.', 400, 'UNSAFE_PATH');
  return value;
}
function decode(buffer) {
  if (buffer.length > MAX_FILE_BYTES) throw failure('File exceeds the 1 MB text limit.', 413, 'FILE_TOO_LARGE');
  if (buffer.includes(0)) throw failure('Binary files are excluded.', 415, 'BINARY_FILE');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw failure('Only UTF-8 text files are supported.', 415, 'BINARY_FILE'); }
}
function validateText(content) {
  if (typeof content !== 'string') throw failure('Each change must provide text content.');
  return decode(Buffer.from(content));
}
async function maybeStat(target) {
  try { return await fs.lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function locked(root, operation) {
  const previous = locks.get(root) || Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  locks.set(root, next);
  await previous;
  try { return await operation(); }
  finally { release(); if (locks.get(root) === next) locks.delete(root); }
}

/** A local-only repository service. The caller supplies the explicitly configured workspace. */
export function createRepositoryService(workspaceRoot, _options = {}) {
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot) || workspaceRoot.includes('\0')) throw failure('Set FORGE_WORKSPACE to an existing absolute directory.', 503, 'WORKSPACE_REQUIRED');
  const root = path.resolve(workspaceRoot);
  if (root === path.parse(root).root) throw failure('The filesystem root cannot be a workspace.', 400, 'UNSAFE_WORKSPACE');

  async function checkRoot() {
    let current = path.parse(root).root;
    for (const part of root.slice(current.length).split(path.sep)) {
      current = path.join(current, part);
      const stat = await maybeStat(current);
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw failure('Workspace must be an existing directory without symlink components.', 503, 'UNSAFE_WORKSPACE');
    }
    if ((await fs.realpath(root)) !== root) throw failure('Workspace resolves outside its configured directory.', 403, 'UNSAFE_WORKSPACE');
    if (!allowedPath(path.basename(root))) throw failure('A credential or internal directory cannot be the workspace.', 403, 'UNSAFE_WORKSPACE');
  }

  async function targetFor(relative, { missing = false } = {}) {
    validatePath(relative);
    await checkRoot();
    let current = root;
    const parts = relative.split('/');
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      const stat = await maybeStat(current);
      if (!stat) {
        if (!missing) throw failure('File does not exist in the workspace.', 404, 'FILE_NOT_FOUND');
        return { absolute: path.join(root, ...parts), stat: null };
      }
      if (stat.isSymbolicLink()) throw failure('Symlink files and directories are excluded.', 403, 'SYMLINK_REFUSED');
      if (index < parts.length - 1 && !stat.isDirectory()) throw failure('A parent path is not a directory.', 409, 'PATH_CONFLICT');
      if (index === parts.length - 1) return { absolute: current, stat };
    }
  }

  async function read(relative) {
    const target = await targetFor(relative);
    if (!target.stat.isFile() || target.stat.nlink > 1) throw failure('Only regular, unlinked text files are supported.', 415, 'UNSUPPORTED_FILE');
    if (target.stat.size > MAX_FILE_BYTES) throw failure('File exceeds the 1 MB text limit.', 413, 'FILE_TOO_LARGE');
    const handle = await fs.open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_FILE_BYTES) throw failure('File changed while it was being opened.', 409, 'FILE_CONFLICT');
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
        if (!result.bytesRead) break;
        bytes += result.bytesRead;
      }
      const content = decode(buffer.subarray(0, bytes));
      return { path: relative, content, hash: hash(content) };
    } finally { await handle.close(); }
  }

  async function list() {
    await checkRoot();
    const files = [];
    let visited = 0;
    let inspectedBytes = 0;
    let truncated = false;
    async function walk(directory, prefix = '', depth = 0) {
      if (depth > 24 || truncated) { truncated = true; return; }
      const entries = await fs.opendir(directory);
      for await (const entry of entries) {
        if (truncated) break;
        if (++visited > 10_000 || files.length >= MAX_TREE_FILES) { truncated = true; break; }
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!allowedPath(relative) || entry.isSymbolicLink()) continue;
        const target = await targetFor(relative).catch(error => { if (error.code === 'FILE_NOT_FOUND' || error.code === 'SYMLINK_REFUSED') return null; throw error; });
        if (!target) continue;
        if (target.stat.isDirectory()) await walk(target.absolute, relative, depth + 1);
        else if (target.stat.isFile() && target.stat.nlink === 1 && target.stat.size <= MAX_FILE_BYTES) {
          if (inspectedBytes + target.stat.size > 20_000_000) { truncated = true; break; }
          inspectedBytes += target.stat.size;
          try { const file = await read(relative); files.push({ path: relative, size: Buffer.byteLength(file.content) }); }
          catch (error) { if (!['BINARY_FILE', 'FILE_TOO_LARGE', 'FILE_NOT_FOUND', 'SYMLINK_REFUSED', 'FILE_CONFLICT'].includes(error.code)) throw error; }
        }
      }
    }
    await walk(root);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files, truncated };
  }

  async function gitBoundary({ optional = false } = {}) {
    await checkRoot();
    const gitDirectory = path.join(root, '.git');
    const stat = await maybeStat(gitDirectory);
    if (!stat) {
      if (optional) return false;
      throw failure('The configured workspace is not a Git repository.', 409, 'NOT_GIT_REPOSITORY');
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('Git metadata must be a directory inside the workspace. Linked worktrees and symlinks are excluded.', 403, 'UNSAFE_GIT_DIRECTORY');
    // Git may follow links in its metadata even when the work tree is bounded.
    const queue = [gitDirectory];
    let inspected = 0;
    while (queue.length) {
      const directory = queue.pop();
      for await (const entry of await fs.opendir(directory)) {
        if (++inspected > 100_000) throw failure('Repository metadata exceeds the inspection limit.', 413, 'GIT_METADATA_TOO_LARGE');
        if (entry.isSymbolicLink()) throw failure('Symlinks inside Git metadata are excluded.', 403, 'UNSAFE_GIT_DIRECTORY');
        if (entry.isDirectory()) queue.push(path.join(directory, entry.name));
      }
    }
    const alternates = await maybeStat(path.join(gitDirectory, 'objects/info/alternates'));
    if (alternates?.size) throw failure('External Git object directories are excluded.', 403, 'UNSAFE_GIT_DIRECTORY');
    return true;
  }

  const gitPrefix = ['--no-optional-locks', '--literal-pathspecs', `--git-dir=${path.join(root, '.git')}`, `--work-tree=${root}`, '-c', 'core.bare=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'commit.gpgSign=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'protocol.allow=never'];
  async function git(args, { index, input, allowFailure = false } = {}) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C' });
    if (index) env.GIT_INDEX_FILE = index;
    try {
      // Even status and diff can invoke clean filters to compare worktree files.
      // Enumerate names only (never credential-bearing values), then override every filter.
      let filterNames = '';
      try { filterNames = (await exec('git', [...gitPrefix, 'config', '--null', '--name-only', '--get-regexp', '^filter\\.'], { cwd: root, env, timeout: 15_000, maxBuffer: 100_000 })).stdout; }
      catch (error) { if (error.code !== 1) throw error; }
      const filters = new Set();
      for (const key of filterNames.split('\0').filter(Boolean)) {
        const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(key);
        if (!match) continue;
        if (!/^[a-zA-Z0-9._/-]{1,200}$/.test(match[1]) || filters.size >= 100) throw failure('Repository filter configuration is unsupported.', 403, 'UNSAFE_GIT_CONFIG');
        filters.add(match[1]);
      }
      const filterOverrides = [...filters].flatMap(name => ['-c', `filter.${name}.clean=`, '-c', `filter.${name}.smudge=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`]);
      if (input === undefined) return (await exec('git', [...gitPrefix, ...filterOverrides, ...args], { cwd: root, env, timeout: 15_000, maxBuffer: 1_000_000 })).stdout;
      return await new Promise((resolve, reject) => {
        const child = execFile('git', [...gitPrefix, ...filterOverrides, ...args], { cwd: root, env, timeout: 15_000, maxBuffer: 1_000_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
        child.stdin.on('error', () => {});
        child.stdin.end(input);
      });
    } catch (error) {
      if (error.status) throw error;
      if (allowFailure && Number.isInteger(error.code)) return null;
      throw failure(error.killed ? 'Git operation timed out.' : 'Git operation failed. Check repository configuration and Git author identity.', 409, 'GIT_FAILED');
    }
  }

  async function status() {
    if (!await gitBoundary({ optional: true })) return { isRepository: false, branch: null, head: null, files: [] };
    const [raw, branchRaw, headRaw] = await Promise.all([
      git(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true }),
      git(['rev-parse', '--verify', 'HEAD'], { allowFailure: true }),
    ]);
    const entries = raw.split('\0');
    const files = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const index = entry[0];
      const worktree = entry[1];
      const relative = entry.slice(3);
      const renamed = index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C';
      const originalPath = renamed ? entries[++i] : undefined;
      if (!allowedPath(relative) || (originalPath && !allowedPath(originalPath))) continue;
      if (relative.endsWith('/')) continue;
      const target = await targetFor(relative, { missing: true }).catch(() => null);
      if (!target || (target.stat && (!target.stat.isFile() || target.stat.nlink > 1))) continue;
      files.push({ path: relative, index, worktree, ...(originalPath ? { originalPath } : {}) });
    }
    return { isRepository: true, branch: branchRaw?.trim() || null, head: headRaw?.trim() || null, files };
  }

  async function applyChanges(input) {
    return locked(root, async () => {
      await checkRoot();
      if (!input || !Array.isArray(input.changes) || !input.changes.length || input.changes.length > 40) throw failure('Provide between 1 and 40 reviewed changes.');
      const seen = new Set();
      const changes = [];
      let total = 0;
      for (const item of input.changes) {
        if (!item || typeof item !== 'object') throw failure('Each change must be an object.');
        const relative = validatePath(item.path);
        if (seen.has(relative)) throw failure('A file can appear only once in a change batch.');
        seen.add(relative);
        if (!Object.hasOwn(item, 'baseHash') || (item.baseHash !== null && !/^[a-f0-9]{64}$/.test(item.baseHash))) throw failure('Every change requires the current baseHash, or null for a new file.', 400, 'BASE_HASH_REQUIRED');
        if (item.delete !== undefined && typeof item.delete !== 'boolean') throw failure('delete must be a boolean.');
        const target = await targetFor(relative, { missing: true });
        if (target.stat && (!target.stat.isFile() || target.stat.nlink > 1)) throw failure('Changes can affect regular text files only.', 409, 'PATH_CONFLICT');
        const before = target.stat ? await read(relative) : null;
        if ((before?.hash ?? null) !== item.baseHash) throw failure(`The file ${relative} changed since it was reviewed. Refresh it before applying changes.`, 409, 'FILE_CONFLICT');
        if (item.delete && !before) throw failure('A missing file cannot be deleted.', 409, 'FILE_CONFLICT');
        const content = item.delete ? undefined : validateText(item.content);
        total += Buffer.byteLength(content || '');
        if (total > 4_000_000) throw failure('Change batch exceeds 4 MB.', 413, 'BATCH_TOO_LARGE');
        changes.push({ path: relative, absolute: target.absolute, content, before, mode: target.stat ? target.stat.mode & 0o777 : undefined, delete: item.delete === true });
      }
      for (const change of changes) {
        if (changes.some(other => other !== change && other.path.startsWith(`${change.path}/`))) throw failure('A change batch cannot include both a file and its descendants.', 409, 'PATH_CONFLICT');
      }
      const staging = await fs.mkdtemp(path.join(root, '.forge-txn-'));
      const applied = [];
      const createdDirectories = [];
      let rollbackFailed = false;
      try {
        await fs.chmod(staging, 0o700);
        for (let i = 0; i < changes.length; i++) {
          if (changes[i].delete) continue;
          const stagedPath = path.join(staging, `${i}.new`);
          await fs.writeFile(stagedPath, changes[i].content, { mode: changes[i].mode ?? 0o644, flag: 'wx' });
          if (changes[i].mode !== undefined) await fs.chmod(stagedPath, changes[i].mode);
        }
        for (let i = 0; i < changes.length; i++) {
          const change = changes[i];
          const target = await targetFor(change.path, { missing: true });
          const current = target.stat ? await read(change.path) : null;
          if ((current?.hash ?? null) !== (change.before?.hash ?? null)) throw failure('A file changed during the transaction. No changes were applied.', 409, 'FILE_CONFLICT');
          let parent = root;
          for (const part of change.path.split('/').slice(0, -1)) {
            parent = path.join(parent, part);
            const stat = await maybeStat(parent);
            if (!stat) { await fs.mkdir(parent); createdDirectories.push(parent); }
            else if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('A parent directory changed during the transaction.', 409, 'PATH_CONFLICT');
          }
          const backup = path.join(staging, `${i}.old`);
          if (change.before) await fs.rename(change.absolute, backup);
          const step = { ...change, backup, installed: false };
          applied.push(step);
          if (!change.delete) { await fs.rename(path.join(staging, `${i}.new`), change.absolute); step.installed = true; }
        }
      } catch (error) {
        for (const step of applied.reverse()) {
          try {
            await targetFor(step.path, { missing: true });
            if (step.installed) await fs.unlink(step.absolute);
            if (step.before) await fs.rename(step.backup, step.absolute);
          } catch { rollbackFailed = true; }
        }
        for (const directory of createdDirectories.reverse()) { try { await fs.rmdir(directory); } catch {} }
        if (rollbackFailed) throw failure('Transaction rollback needs attention. Original files remain in the private transaction directory.', 500, 'ROLLBACK_FAILED');
        throw error;
      } finally {
        if (!rollbackFailed) await fs.rm(staging, { recursive: true, force: true });
      }
      return { files: changes.map(change => ({ path: change.path, hash: change.delete ? null : hash(change.content), deleted: change.delete })), changedPaths: changes.map(change => change.path) };
    });
  }

  return {
    async info() { await checkRoot(); return { root, name: path.basename(root), configured: true, ...(await status()) }; },
    tree: list,
    readFile: read,
    async search(query) {
      if (typeof query !== 'string' || !query.trim() || query.length > 200 || /[\x00\r\n]/.test(query)) throw failure('Search requires a single literal text query of at most 200 characters.');
      const listing = await list();
      const matches = [];
      let truncated = listing.truncated;
      let scanned = 0;
      for (const entry of listing.files) {
        const file = await read(entry.path).catch(() => null);
        if (!file) continue;
        scanned += Buffer.byteLength(file.content);
        if (scanned > 5_000_000) { truncated = true; break; }
        const lines = file.content.split('\n');
        for (let line = 0; line < lines.length; line++) {
          const column = lines[line].indexOf(query);
          if (column < 0) continue;
          matches.push({ path: file.path, line: line + 1, column: column + 1, text: lines[line].slice(Math.max(0, column - 120), column + query.length + 300) });
          if (matches.length >= 200) { truncated = true; break; }
        }
        if (truncated && matches.length >= 200) break;
      }
      return { matches, truncated };
    },
    applyChanges,
    gitStatus: status,
    async gitDiff() {
      const current = await status();
      if (!current.isRepository) throw failure('The workspace is not a Git repository.', 409, 'NOT_GIT_REPOSITORY');
      const paths = [];
      for (const item of current.files) {
        if (item.index === '?' && item.worktree === '?') continue;
        const target = await targetFor(item.path, { missing: true });
        if (target.stat) { try { await read(item.path); } catch { continue; } }
        paths.push(item.path);
        if (item.originalPath) paths.push(item.originalPath);
      }
      if (!paths.length) return '';
      if (current.head) return git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD', '--', ...paths]);
      return git(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--', ...paths]);
    },
    async createBranch(name) {
      return locked(root, async () => {
        await gitBoundary();
        if (typeof name !== 'string' || name.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes('..') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock') || name.includes('//') || name.split('/').some(part => part.startsWith('.'))) throw failure('Provide a safe Git branch name.', 400, 'INVALID_BRANCH');
        if (await git(['check-ref-format', '--branch', name], { allowFailure: true }) === null) throw failure('Provide a valid Git branch name.', 400, 'INVALID_BRANCH');
        await git(['switch', '--create', name]);
        return { branch: name, ...(await status()) };
      });
    },
    async commit(input) {
      return locked(root, async () => {
        await gitBoundary();
        if (!input || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 4000 || input.message.includes('\0')) throw failure('A nonempty commit message of at most 4000 characters is required.');
        if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > 100 || new Set(input.paths).size !== input.paths.length) throw failure('Select between 1 and 100 unique files to commit.');
        const contents = [];
        for (const relative of input.paths) {
          validatePath(relative);
          const target = await targetFor(relative, { missing: true });
          if (target.stat && (!target.stat.isFile() || target.stat.nlink > 1)) throw failure('Only regular text files can be committed.', 409, 'UNSUPPORTED_FILE');
          contents.push({ path: relative, file: target.stat ? await read(relative) : null, mode: target.stat && (target.stat.mode & 0o111) ? '100755' : '100644' });
        }
        const temporary = await fs.mkdtemp(path.join(root, '.forge-txn-'));
        await fs.chmod(temporary, 0o700);
        const index = path.join(temporary, 'index');
        let commitCreated = false;
        let head;
        try {
          const previousHead = await git(['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
          await git(previousHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], { index });
          for (const item of contents) {
            if (!item.file) await git(['update-index', '--force-remove', '--', item.path], { index });
            else {
              const object = (await git(['hash-object', '-w', '--no-filters', '--stdin'], { input: item.file.content })).trim();
              await git(['update-index', '--add', '--cacheinfo', `${item.mode},${object},${item.path}`], { index });
            }
          }
          const staged = await git(['diff', '--cached', '--name-only', '-z'], { index });
          if (!staged) throw failure('The selected files contain no changes to commit.', 409, 'NO_CHANGES');
          await git(['commit', '--no-gpg-sign', '--no-verify', '--no-status', '-m', input.message.trim()], { index });
          commitCreated = true;
          head = (await git(['rev-parse', '--verify', 'HEAD'])).trim();
          // Refresh only the selected paths in the real index; unrelated staged work survives.
          await git(['reset', '--quiet', 'HEAD', '--', ...input.paths]);
          return { head, sha: head, paths: [...input.paths], message: input.message.trim(), ...(await status()) };
        } catch (error) {
          if (commitCreated) throw failure(`Commit ${head || 'HEAD'} was created, but refreshing the index failed. Inspect Git status before retrying.`, 500, 'COMMIT_INDEX_REFRESH_FAILED');
          throw error;
        } finally { await fs.rm(temporary, { recursive: true, force: true }); }
      });
    },
    async snapshot() {
      const listing = await list();
      const files = [];
      let totalBytes = 0;
      let truncated = listing.truncated;
      for (const entry of listing.files) {
        if (files.length >= 100) { truncated = true; break; }
        if (totalBytes + entry.size > 500_000) { truncated = true; continue; }
        const file = await read(entry.path).catch(() => null);
        if (!file) continue;
        const bytes = Buffer.byteLength(file.content);
        if (totalBytes + bytes > 500_000) { truncated = true; continue; }
        files.push(file);
        totalBytes += bytes;
      }
      return { files, totalBytes, truncated };
    },
  };
}

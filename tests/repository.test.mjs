import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRepositoryService } from '../server/repository.mjs';

const exec = promisify(execFile);
async function fixture(t, { git = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-repository-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runGit = async (...args) => (await exec('git', args, { cwd: root, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))) })).stdout;
  if (git) {
    await runGit('init', '-q', '-b', 'main');
    await runGit('config', 'user.name', 'Repository Test');
    await runGit('config', 'user.email', 'test@example.invalid');
  }
  return { root, service: createRepositoryService(root), git: runGit, write: async (relative, content) => { await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await fs.writeFile(path.join(root, relative), content); } };
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('workspace requires an explicit existing absolute directory and refuses symlink roots', async t => {
  assert.throws(() => createRepositoryService(), error => error.code === 'WORKSPACE_REQUIRED');
  assert.throws(() => createRepositoryService('relative'), error => error.code === 'WORKSPACE_REQUIRED');
  assert.throws(() => createRepositoryService('/'), error => error.code === 'UNSAFE_WORKSPACE');
  const { root, service } = await fixture(t);
  assert.equal((await service.info()).isRepository, false);
  await rejectsCode(createRepositoryService(path.join(root, 'missing')).info(), 'UNSAFE_WORKSPACE');
  await fs.symlink(root, `${root}-link`);
  t.after(() => fs.unlink(`${root}-link`));
  await rejectsCode(createRepositoryService(`${root}-link`).tree(), 'UNSAFE_WORKSPACE');
  await fs.symlink(root, path.join(root, 'nested-link'));
  await rejectsCode(createRepositoryService(path.join(root, 'nested-link')).tree(), 'UNSAFE_WORKSPACE');
});

test('real file reads include reproducible content hashes and never expose secret or traversal paths', async t => {
  const { root, service, write } = await fixture(t);
  await write('src/main.js', 'export const value = 1;\n');
  const file = await service.readFile('src/main.js');
  assert.equal(file.content, 'export const value = 1;\n');
  assert.match(file.hash, /^[a-f0-9]{64}$/);
  assert.equal((await service.readFile('src/main.js')).hash, file.hash);
  for (const relative of ['../outside', '/etc/passwd', 'a/../x', './x', 'a//b', 'a\\b', 'a\0b', 'a\nb', 'C:/x', '.git/config', '.env', '.env.local', 'nested/.env.production', 'credentials.json', 'service-account-prod.json', '.ssh/id_rsa', 'id_ed25519', '.npmrc', '.pypirc', 'kubeconfig', 'terraform.tfstate', 'secret.auto.tfvars', 'certificate.pem', 'private.key', 'node_modules/index.js', '.cache/value', '.config/gcloud/application_default_credentials.json']) {
    await rejectsCode(service.readFile(relative), 'UNSAFE_PATH');
  }
  for (const relative of ['.env.example', 'credentials.example.json', 'terraform.tfvars.example']) {
    await write(relative, 'public example');
    assert.equal((await service.readFile(relative)).content, 'public example');
  }
  await write('.env', 'SUPER_SECRET_TOKEN');
  const tree = await service.tree();
  assert.ok(!tree.files.some(entry => entry.path === '.env'));
  assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), 'SUPER_SECRET_TOKEN');
});

test('symlink files, parent directories, hard links, binary files, and oversized files are excluded', async t => {
  const { root, service, write } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-outside-test-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'token.txt'), 'OUTSIDE_SECRET');
  await fs.symlink(path.join(outside, 'token.txt'), path.join(root, 'linked.txt'));
  await fs.symlink(outside, path.join(root, 'linked-directory'));
  await fs.link(path.join(outside, 'token.txt'), path.join(root, 'hardlink.txt'));
  await write('binary.dat', Buffer.from([0, 1, 2]));
  await write('invalid.txt', Buffer.from([0xff, 0xfe]));
  await write('large.txt', 'x'.repeat(1_000_001));
  await write('good.txt', 'ordinary text');
  await rejectsCode(service.readFile('linked.txt'), 'SYMLINK_REFUSED');
  await rejectsCode(service.readFile('linked-directory/token.txt'), 'SYMLINK_REFUSED');
  await rejectsCode(service.readFile('hardlink.txt'), 'UNSUPPORTED_FILE');
  await rejectsCode(service.readFile('binary.dat'), 'BINARY_FILE');
  await rejectsCode(service.readFile('invalid.txt'), 'BINARY_FILE');
  await rejectsCode(service.readFile('large.txt'), 'FILE_TOO_LARGE');
  assert.deepEqual((await service.tree()).files.map(file => file.path), ['good.txt']);
  assert.deepEqual((await service.snapshot()).files.map(file => file.path), ['good.txt']);
});

test('reviewed changes create, replace, and delete real disk files with optimistic hashes', async t => {
  const { root, service, write } = await fixture(t);
  await write('main.js', 'before');
  const before = await service.readFile('main.js');
  const result = await service.applyChanges({ changes: [{ path: 'main.js', content: 'after', baseHash: before.hash }, { path: 'src/new.js', content: 'new file', baseHash: null }] });
  assert.deepEqual(result.changedPaths, ['main.js', 'src/new.js']);
  assert.equal(await fs.readFile(path.join(root, 'main.js'), 'utf8'), 'after');
  assert.equal(await fs.readFile(path.join(root, 'src/new.js'), 'utf8'), 'new file');
  assert.equal(result.files[0].hash, (await service.readFile('main.js')).hash);
  assert.equal(result.files[0].deleted, false);
  const deletion = await service.applyChanges({ changes: [{ path: 'main.js', delete: true, baseHash: result.files[0].hash }] });
  assert.deepEqual(deletion.files, [{ path: 'main.js', hash: null, deleted: true }]);
  await assert.rejects(fs.stat(path.join(root, 'main.js')), { code: 'ENOENT' });
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('.forge-txn-')), false);
});

test('every batch is validated before modifying files; stale, absent, duplicate, and invalid hashes fail', async t => {
  const { root, service, write } = await fixture(t);
  await write('main.js', 'unchanged');
  const before = await service.readFile('main.js');
  for (const changes of [
    [{ path: 'main.js', content: 'bad' }],
    [{ path: 'main.js', content: 'bad', baseHash: null }],
    [{ path: 'new.js', content: 'bad', baseHash: before.hash }],
    [{ path: 'main.js', content: 'bad', baseHash: '0'.repeat(64) }],
    [{ path: 'main.js', content: 'bad', baseHash: before.hash }, { path: 'main.js', content: 'also bad', baseHash: before.hash }],
    [{ path: 'main.js', content: 'bad', baseHash: before.hash }, { path: '.env', content: 'secret', baseHash: null }],
    [{ path: 'main.js', content: 'bad', baseHash: before.hash }, { path: 'new.js', content: '\0binary', baseHash: null }],
    [{ path: 'new.js', content: 'x'.repeat(1_000_001), baseHash: null }],
    [{ path: 'new.js', delete: true, baseHash: null }],
    [{ path: 'parent', content: 'file', baseHash: null }, { path: 'parent/child', content: 'child', baseHash: null }],
  ]) await assert.rejects(service.applyChanges({ changes }));
  assert.equal(await fs.readFile(path.join(root, 'main.js'), 'utf8'), 'unchanged');
  assert.deepEqual(await fs.readdir(root), ['main.js']);
});

test('concurrent mutations serialize even across service instances and prevent lost updates', async t => {
  const { root, service, write } = await fixture(t);
  await write('main.js', 'base');
  const { hash } = await service.readFile('main.js');
  const other = createRepositoryService(root);
  const outcomes = await Promise.allSettled([
    service.applyChanges({ changes: [{ path: 'main.js', content: 'first', baseHash: hash }] }),
    other.applyChanges({ changes: [{ path: 'main.js', content: 'second', baseHash: hash }] }),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'FILE_CONFLICT');
  assert.equal(await fs.readFile(path.join(root, 'main.js'), 'utf8'), 'first');
});

test('symlink parents are refused before any writes and ordinary file modes survive replacement', async t => {
  const { root, service, write } = await fixture(t);
  await write('script.sh', '#!/bin/sh\necho before\n');
  await fs.chmod(path.join(root, 'script.sh'), 0o755);
  await fs.symlink(os.tmpdir(), path.join(root, 'linked'));
  const before = await service.readFile('script.sh');
  await rejectsCode(service.applyChanges({ changes: [{ path: 'script.sh', content: 'changed', baseHash: before.hash }, { path: 'linked/escape.js', content: 'escape', baseHash: null }] }), 'SYMLINK_REFUSED');
  assert.equal((await service.readFile('script.sh')).content, before.content);
  await service.applyChanges({ changes: [{ path: 'script.sh', content: '#!/bin/sh\necho after\n', baseHash: before.hash }] });
  assert.equal((await fs.stat(path.join(root, 'script.sh'))).mode & 0o777, 0o755);
});

test('search treats shell metacharacters literally and bounds results; snapshots stay within context budgets', async t => {
  const { service, write } = await fixture(t);
  await write('src/main.js', 'first\n$(touch marker)\nthird\n');
  await write('.env', '$(touch marker) SECRET');
  assert.deepEqual((await service.search('$(touch marker)')).matches, [{ path: 'src/main.js', line: 2, column: 1, text: '$(touch marker)' }]);
  await write('many.txt', Array(250).fill('needle').join('\n'));
  const many = await service.search('needle');
  assert.equal(many.matches.length, 200);
  assert.equal(many.truncated, true);
  await write('big.txt', 'x'.repeat(490_000));
  await write('big2.txt', 'y'.repeat(490_000));
  for (let index = 0; index < 105; index++) await write(`small-${index}.js`, 'tiny');
  const snapshot = await service.snapshot();
  assert.ok(snapshot.files.length <= 100);
  assert.ok(snapshot.totalBytes <= 500_000);
  assert.equal(snapshot.totalBytes, snapshot.files.reduce((total, file) => total + Buffer.byteLength(file.content), 0));
  assert.equal(snapshot.truncated, true);
  assert.ok(snapshot.files.every(file => /^[a-f0-9]{64}$/.test(file.hash)));
  assert.ok(!snapshot.files.some(file => file.path === '.env'));
  await assert.rejects(service.search(''));
  await assert.rejects(service.search('two\nlines'));
});

test('Git status, safe diff, branch creation, and commit reflect actual repository history', async t => {
  const { root, service, write, git } = await fixture(t, { git: true });
  await write('main.js', 'export const value = 1;\n');
  await git('add', '--', 'main.js');
  await git('commit', '-q', '-m', 'Initial');
  const original = (await git('rev-parse', 'HEAD')).trim();
  assert.equal((await service.gitStatus()).head, original);
  assert.equal((await service.gitStatus()).branch, 'main');
  assert.equal((await service.createBranch('forge/improve-main')).branch, 'forge/improve-main');
  await write('main.js', 'export const value = 2;\n');
  assert.deepEqual((await service.gitStatus()).files, [{ path: 'main.js', index: ' ', worktree: 'M' }]);
  assert.match(await service.gitDiff(), /\+export const value = 2/);
  const result = await service.commit({ message: 'Improve main', paths: ['main.js'] });
  assert.match(result.sha, /^[a-f0-9]{40,64}$/);
  assert.notEqual(result.sha, original);
  assert.equal(result.sha, (await git('rev-parse', 'HEAD')).trim());
  assert.equal(await git('show', 'HEAD:main.js'), 'export const value = 2;\n');
  assert.equal((await service.gitStatus()).files.length, 0);
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('.forge-txn-')), false);
  await rejectsCode(service.commit({ message: 'Empty', paths: ['main.js'] }), 'NO_CHANGES');
  for (const branch of ['--help', '../escape', 'bad branch', 'bad;touch-marker', 'bad..branch', 'bad.lock', 'bad/.hidden', 'bad/']) await rejectsCode(service.createBranch(branch), 'INVALID_BRANCH');
});

test('commit isolates explicit files from other staged changes and supports creation and deletion', async t => {
  const { service, write, git, root } = await fixture(t, { git: true });
  await write('main.js', 'one');
  await write('unrelated.js', 'original');
  await git('add', '--', 'main.js', 'unrelated.js');
  await git('commit', '-q', '-m', 'Initial');
  await write('unrelated.js', 'unreviewed staged');
  await git('add', '--', 'unrelated.js');
  await write('main.js', 'two');
  const result = await service.commit({ message: 'Only main', paths: ['main.js'] });
  assert.equal(await git('show', 'HEAD:unrelated.js'), 'original');
  assert.equal(await git('show', ':unrelated.js'), 'unreviewed staged');
  assert.deepEqual(result.files, [{ path: 'unrelated.js', index: 'M', worktree: ' ' }]);
  await write('new.js', 'created');
  await fs.unlink(path.join(root, 'main.js'));
  await service.commit({ message: 'Create and delete selected', paths: ['main.js', 'new.js'] });
  assert.equal(await git('show', 'HEAD:new.js'), 'created');
  await assert.rejects(git('show', 'HEAD:main.js'));
  assert.equal(await git('show', ':unrelated.js'), 'unreviewed staged');
});

test('initial commit works without any prior HEAD and never includes unselected work', async t => {
  const { service, write, git } = await fixture(t, { git: true });
  await write('first.js', 'first');
  await write('other.js', 'not selected');
  await git('add', '--', 'other.js');
  const result = await service.commit({ message: 'First commit', paths: ['first.js'] });
  assert.equal(result.head, (await git('rev-parse', 'HEAD')).trim());
  assert.equal(await git('show', 'HEAD:first.js'), 'first');
  await assert.rejects(git('show', 'HEAD:other.js'));
  assert.equal(await git('show', ':other.js'), 'not selected');
});

test('Git commands never run hooks, clean filters, external diff commands, or text conversions', async t => {
  const { root, service, write, git } = await fixture(t, { git: true });
  await write('main.js', 'one\n');
  await git('add', '--', 'main.js');
  await git('commit', '-q', '-m', 'Initial');
  const marker = path.join(root, 'executed-marker');
  await write('.gitattributes', '*.js filter=hostile diff=hostile\n');
  await git('config', 'filter.hostile.clean', `touch '${marker}'; cat`);
  await git('config', 'filter.hostile.required', 'true');
  await git('config', 'diff.hostile.command', `touch '${marker}'`);
  await git('config', 'diff.hostile.textconv', `touch '${marker}'`);
  await write('.git/hooks/pre-commit', `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  await write('.git/hooks/prepare-commit-msg', `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  await fs.chmod(path.join(root, '.git/hooks/pre-commit'), 0o755);
  await fs.chmod(path.join(root, '.git/hooks/prepare-commit-msg'), 0o755);
  await write('main.js', 'two\n');
  assert.match(await service.gitDiff(), /\+two/);
  await service.commit({ message: 'Safe commit', paths: ['main.js'] });
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  assert.equal(await git('show', 'HEAD:main.js'), 'two\n');
});

test('Git diff and status exclude credential filenames, including credentials already tracked by Git', async t => {
  const { service, write, git } = await fixture(t, { git: true });
  await write('.env', 'TOKEN=OLD_SECRET\n');
  await write('main.js', 'old public\n');
  await git('add', '--', '.env', 'main.js');
  await git('commit', '-q', '-m', 'Initial');
  await write('.env', 'TOKEN=NEW_SECRET\n');
  await write('credentials.json', 'UNTRACKED_SECRET');
  await write('main.js', 'new public\n');
  assert.deepEqual((await service.gitStatus()).files.map(file => file.path), ['main.js']);
  const diff = await service.gitDiff();
  assert.match(diff, /new public/);
  assert.doesNotMatch(diff, /SECRET|TOKEN|credentials|\.env/);
  await rejectsCode(service.commit({ message: 'Unsafe', paths: ['.env'] }), 'UNSAFE_PATH');
});

test('Git refuses symlink metadata and external object stores; inherited GIT variables cannot redirect it', async t => {
  const { root, service, git } = await fixture(t, { git: true });
  const other = await fixture(t, { git: true });
  const before = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT };
  Object.assign(process.env, { GIT_DIR: path.join(other.root, '.git'), GIT_WORK_TREE: other.root, GIT_CONFIG_COUNT: '99999' });
  try { assert.equal((await service.gitStatus()).branch, 'main'); }
  finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  await fs.symlink(path.join(other.root, '.git/config'), path.join(root, '.git/hostile-link'));
  await rejectsCode(service.gitStatus(), 'UNSAFE_GIT_DIRECTORY');
  await fs.unlink(path.join(root, '.git/hostile-link'));
  await fs.writeFile(path.join(root, '.git/objects/info/alternates'), path.join(other.root, '.git/objects'));
  await rejectsCode(service.gitStatus(), 'UNSAFE_GIT_DIRECTORY');
  await fs.unlink(path.join(root, '.git/objects/info/alternates'));
  await git('config', 'user.name', 'Still local');
  await fs.rename(path.join(root, '.git'), path.join(root, 'metadata'));
  await fs.symlink(path.join(root, 'metadata'), path.join(root, '.git'));
  await rejectsCode(service.gitStatus(), 'UNSAFE_GIT_DIRECTORY');
});

test('real transaction failure rolls back earlier files and preserves the conflicting external edit', async t => {
  const { root, service, write } = await fixture(t);
  await write('first.js', 'first original');
  await write('last.js', 'last original');
  const first = await service.readFile('first.js');
  const last = await service.readFile('last.js');
  // A watcher represents a concurrent external editor, outside this service's mutex.
  const observer = watch(root, (event, filename) => {
    if (event === 'rename' && filename === 'first.js') {
      observer.close();
      // writeFile schedules before the next target is read; changing last.js then forces rollback.
      fs.writeFile(path.join(root, 'last.js'), 'external editor change').catch(() => {});
    }
  });
  t.after(() => observer.close());
  const changes = [{ path: 'first.js', content: 'first changed', baseHash: first.hash }];
  // Intermediate files make the externally observable race deterministic without a test-only production hook.
  for (let index = 0; index < 20; index++) changes.push({ path: `intermediate-${index}.js`, content: 'temporary change', baseHash: null });
  changes.push({ path: 'last.js', content: 'last changed', baseHash: last.hash });
  await rejectsCode(service.applyChanges({ changes }), 'FILE_CONFLICT');
  assert.equal(await fs.readFile(path.join(root, 'first.js'), 'utf8'), 'first original');
  assert.equal(await fs.readFile(path.join(root, 'last.js'), 'utf8'), 'external editor change');
  assert.deepEqual((await fs.readdir(root)).sort(), ['first.js', 'last.js']);
});

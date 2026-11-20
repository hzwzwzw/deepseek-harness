/** Exercise upstream synchronization against isolated local Git repositories. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./sync-linux-upstream.sh', import.meta.url))

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'linux-upstream-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const upstream = join(root, 'upstream.git')
  const fork = join(root, 'fork.git')
  const seed = join(root, 'seed')
  const work = join(root, 'work')
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const identity = cwd => {
    git(cwd, 'config', 'user.name', 'Sync test')
    git(cwd, 'config', 'user.email', 'sync@example.invalid')
    git(cwd, 'config', 'commit.gpgsign', 'false')
    git(cwd, 'config', 'core.hooksPath', '/dev/null')
  }
  git(root, 'init', '--bare', upstream)
  git(root, 'init', '--bare', fork)
  git(root, 'init', '-b', 'master', seed)
  identity(seed)
  writeFileSync(join(seed, 'package.json'), '{"version":"0.2.2-rc.5"}\n')
  writeFileSync(join(seed, 'shared.txt'), 'base\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '-m', 'base')
  git(seed, 'push', upstream, 'HEAD:master')
  git(seed, 'push', fork, 'HEAD:linux-desktop-build')
  git(root, 'clone', '--branch', 'linux-desktop-build', fork, work)
  identity(work)
  const commit = (cwd, file, content) => {
    writeFileSync(join(cwd, file), content)
    git(cwd, 'add', file)
    git(cwd, 'commit', '-m', `Update ${file}`)
  }
  const run = (url = upstream) => spawnSync('bash', [script], {
    cwd: work, encoding: 'utf8', env: { ...process.env,
      PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
      UPSTREAM_REMOTE_URL: url, GITHUB_OUTPUT: join(root, 'output'), GITHUB_STEP_SUMMARY: join(root, 'summary'),
    },
  })
  return { root, upstream, fork, seed, work, git, commit, run }
}

test('does not create a commit when upstream is already included', t => {
  const f = fixture(t)
  const before = f.git(f.work, 'rev-parse', 'HEAD')
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(f.git(f.work, 'rev-parse', 'HEAD'), before)
  assert.match(readFileSync(join(f.root, 'output'), 'utf8'), new RegExp(`sha=${before}`))
})

test('merges upstream while retaining Linux changes and pushes a descendant', t => {
  const f = fixture(t)
  f.commit(f.work, 'linux.txt', 'Linux controls\n')
  f.git(f.work, 'push', 'origin', 'HEAD:linux-desktop-build')
  const previous = f.git(f.work, 'rev-parse', 'HEAD')
  f.commit(f.seed, 'upstream.txt', 'new official source\n')
  f.git(f.seed, 'push', f.upstream, 'HEAD:master')
  const upstream = f.git(f.seed, 'rev-parse', 'HEAD')
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(f.work, 'linux.txt'), 'utf8'), 'Linux controls\n')
  assert.equal(readFileSync(join(f.work, 'upstream.txt'), 'utf8'), 'new official source\n')
  f.git(f.work, 'merge-base', '--is-ancestor', previous, 'HEAD')
  f.git(f.work, 'merge-base', '--is-ancestor', upstream, 'HEAD')
  assert.equal(f.git(f.root, '--git-dir', f.fork, 'rev-parse', 'linux-desktop-build'), f.git(f.work, 'rev-parse', 'HEAD'))
})

test('reports conflicts, aborts the merge and leaves the remote unchanged', t => {
  const f = fixture(t)
  f.commit(f.work, 'shared.txt', 'Linux variant\n')
  f.git(f.work, 'push', 'origin', 'HEAD:linux-desktop-build')
  const previous = f.git(f.work, 'rev-parse', 'HEAD')
  f.commit(f.seed, 'shared.txt', 'official variant\n')
  f.git(f.seed, 'push', f.upstream, 'HEAD:master')
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /no fork branch was pushed/)
  assert.match(readFileSync(join(f.root, 'summary'), 'utf8'), /shared.txt/)
  assert.equal(f.git(f.root, '--git-dir', f.fork, 'rev-parse', 'linux-desktop-build'), previous)
  assert.equal(readFileSync(join(f.work, 'shared.txt'), 'utf8'), 'Linux variant\n')
  assert.equal(existsSync(join(f.work, '.git', 'MERGE_HEAD')), false)
})

test('a failed upstream fetch leaves the fork unchanged', t => {
  const f = fixture(t)
  const previous = f.git(f.work, 'rev-parse', 'HEAD')
  assert.notEqual(f.run(join(f.root, 'missing.git')).status, 0)
  assert.equal(f.git(f.root, '--git-dir', f.fork, 'rev-parse', 'linux-desktop-build'), previous)
})

test('retains fork workflows when upstream edits or adds workflow files', t => {
  const f = fixture(t)
  for (const cwd of [f.work, f.seed]) mkdirSync(join(cwd, '.github', 'workflows'), { recursive: true })
  f.commit(f.work, '.github/workflows/linux.yml', 'name: Fork Linux\n')
  f.git(f.work, 'push', 'origin', 'HEAD:linux-desktop-build')
  f.commit(f.seed, '.github/workflows/linux.yml', 'name: Official Linux\n')
  f.commit(f.seed, '.github/workflows/new.yml', 'name: Official publishing\n')
  f.git(f.seed, 'push', f.upstream, 'HEAD:master')
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(f.work, '.github/workflows/linux.yml'), 'utf8'), 'name: Fork Linux\n')
  assert.equal(existsSync(join(f.work, '.github/workflows/new.yml')), false)
  f.git(f.work, 'merge-base', '--is-ancestor', f.git(f.seed, 'rev-parse', 'HEAD'), 'HEAD')
})

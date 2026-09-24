// 3.2 快照 / 3.3 并发暂存 / 3.4 特殊流程
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { Sandbox, type Repo } from '../helpers/repo.ts'
import { writeNodeHook, writeShellHook } from '../helpers/hooks.ts'
import { FIXTURES } from '../helpers/paths.ts'
import { Git } from '../../src/git/git.ts'
import { specialState } from '../../src/git/state.ts'

const PROBE = join(FIXTURES, 'snapshot-probe.ts')

interface Probe { base: string; target: string; unborn: boolean; empty: boolean; head: string | null }

function commitWithProbe(repo: Repo, args: string[]): Probe {
  const out = join(repo.sandbox.root, `probe-${Math.random().toString(36).slice(2)}.json`)
  repo.git(['commit', '-q', ...args], { env: { PROBE_OUT: out } })
  return JSON.parse(readFileSync(out, 'utf8')) as Probe
}

function setup(t: { after: (fn: () => void) => void }, opts: { initialCommit?: boolean } = {}) {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const repo = sb.repo('repo', opts)
  writeNodeHook(repo, 'prepare-commit-msg', PROBE)
  return repo
}

test('普通提交：捕获的 target 等于最终 commit tree，base 等于父提交的 tree', (t) => {
  const repo = setup(t)
  const parentTree = repo.headTree()
  repo.write('a.txt', 'a\n')
  repo.git(['add', 'a.txt'])
  const p = commitWithProbe(repo, ['-m', 'x'])
  assert.equal(p.target, repo.headTree())
  assert.equal(p.base, parentTree)
  assert.equal(p.empty, false)
})

test('同一文件既有已暂存又有未暂存的修改：只捕获已暂存的部分', (t) => {
  const repo = setup(t)
  repo.write('f.txt', 'staged\n')
  repo.git(['add', 'f.txt'])
  repo.write('f.txt', 'staged\nunstaged\n')
  const p = commitWithProbe(repo, ['-m', 'x'])
  assert.equal(p.target, repo.headTree())
  assert.equal(repo.git(['show', 'HEAD:f.txt']).stdout, 'staged\n')
})

test('git commit -a：捕获 Git 准备的临时 index', (t) => {
  const repo = setup(t)
  repo.write('README.md', 'changed but not staged\n')
  const p = commitWithProbe(repo, ['-a', '-m', 'x'])
  assert.equal(p.target, repo.headTree())
  assert.equal(repo.git(['show', 'HEAD:README.md']).stdout, 'changed but not staged\n')
})

test('限定路径提交：只捕获本次真正提交的文件', (t) => {
  const repo = setup(t)
  repo.write('staged.txt', 's\n')
  repo.git(['add', 'staged.txt'])
  repo.write('README.md', 'path commit\n')
  const p = commitWithProbe(repo, ['-m', 'x', '--', 'README.md'])
  assert.equal(p.target, repo.headTree())
  assert.equal(repo.git(['ls-tree', '--name-only', 'HEAD']).stdout.includes('staged.txt'), false)
})

test('首次提交：unborn HEAD 以 Git 计算的空 tree 为基准', (t) => {
  const repo = setup(t, { initialCommit: false })
  repo.write('first.txt', '1\n')
  repo.git(['add', 'first.txt'])
  const p = commitWithProbe(repo, ['-m', 'first'])
  assert.equal(p.unborn, true)
  assert.equal(p.head, null)
  assert.equal(p.base, repo.git(['hash-object', '-t', 'tree', '/dev/null']).stdout.trim())
  assert.equal(p.target, repo.headTree())
})

test('pre-commit 格式化并重新暂存后，捕获的是格式化之后的内容', (t) => {
  const repo = setup(t)
  writeShellHook(repo, 'pre-commit', "printf 'formatted\\n' > fmt.txt && git add fmt.txt")
  repo.write('fmt.txt', 'raw   \n')
  repo.git(['add', 'fmt.txt'])
  const p = commitWithProbe(repo, ['-m', 'x'])
  assert.equal(p.target, repo.headTree())
  assert.equal(repo.git(['show', 'HEAD:fmt.txt']).stdout, 'formatted\n')
})

test('空提交：base 等于 target', (t) => {
  const repo = setup(t)
  const p = commitWithProbe(repo, ['--allow-empty', '-m', 'empty'])
  assert.equal(p.empty, true)
})

// ---------- 3.3 并发暂存 ----------

async function commitWhileStaging(repo: Repo, commitArgs: string[]) {
  const sb = repo.sandbox
  const out = join(sb.root, 'probe.json')
  const ready = join(sb.root, 'ready')
  const child = spawn('git', ['commit', '-q', ...commitArgs], {
    cwd: repo.dir,
    env: sb.env({ PROBE_OUT: out, PROBE_READY: ready, PROBE_HOLD_MS: '1500' }),
    stdio: 'ignore',
  })
  const done = new Promise<number>((res) => child.on('exit', (c) => res(c ?? -1)))
  for (let i = 0; i < 200 && !existsSync(ready); i++) await sleep(20)
  assert.ok(existsSync(ready), 'hook 已进入等待')
  repo.write('late.txt', 'late\n')
  const add = repo.git(['add', 'late.txt'], { allowFail: true })
  const commitStatus = await done
  const probe = JSON.parse(readFileSync(out, 'utf8')) as Probe
  return { add, commitStatus, probe }
}

test('并发暂存：普通提交的内容在 hook 调用前已固定', async (t) => {
  const repo = setup(t)
  repo.write('a.txt', 'a\n')
  repo.git(['add', 'a.txt'])
  const { add, commitStatus, probe } = await commitWhileStaging(repo, ['-m', 'plain'])
  assert.equal(add.status, 0, '普通提交期间并发 git add 成功')
  assert.equal(commitStatus, 0)
  assert.equal(repo.headTree(), probe.target, '最终 tree 等于 hook 开始时的快照')
  assert.equal(repo.git(['ls-tree', '--name-only', 'HEAD']).stdout.includes('late.txt'), false)
  assert.match(repo.git(['diff', '--cached', '--name-only']).stdout, /late\.txt/, '新文件提交后仍处于暂存状态')
})

test('并发暂存：git commit -a 期间 index 被锁，并发 git add 以 128 失败', async (t) => {
  const repo = setup(t)
  repo.write('README.md', 'modified\n')
  const { add, commitStatus, probe } = await commitWhileStaging(repo, ['-a', '-m', 'all'])
  assert.equal(add.status, 128)
  assert.equal(commitStatus, 0)
  assert.equal(repo.headTree(), probe.target)
})

test('并发暂存：限定路径提交期间 index 被锁，并发 git add 以 128 失败', async (t) => {
  const repo = setup(t)
  repo.write('README.md', 'modified\n')
  const { add, commitStatus, probe } = await commitWhileStaging(repo, ['-m', 'path', '--', 'README.md'])
  assert.equal(add.status, 128)
  assert.equal(commitStatus, 0)
  assert.equal(repo.headTree(), probe.target)
})

// ---------- 3.4 特殊流程 ----------

function conflictRepo(t: { after: (fn: () => void) => void }, worktree = false) {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const main = sb.repo()
  const repo = worktree ? main.addWorktree('wt') : main
  repo.write('f.txt', 'base\n'); repo.git(['add', 'f.txt']); repo.git(['commit', '-q', '-m', 'base'])
  const baseBranch = repo.git(['branch', '--show-current']).stdout.trim()
  repo.git(['checkout', '-q', '-b', 'other'])
  repo.write('f.txt', 'other\n'); repo.git(['commit', '-q', '-am', 'other'])
  const otherCommit = repo.git(['rev-parse', 'HEAD']).stdout.trim()
  repo.write('f.txt', 'other2\n'); repo.git(['commit', '-q', '-am', 'other2'])
  const other2Commit = repo.git(['rev-parse', 'HEAD']).stdout.trim()
  repo.git(['checkout', '-q', baseBranch])
  repo.write('f.txt', 'mine\n'); repo.git(['commit', '-q', '-am', 'mine'])
  return { repo, otherCommit, other2Commit }
}

const detect = (repo: Repo) => specialState(new Git(repo.dir, repo.sandbox.env()))

test('特殊流程：merge 冲突', (t) => {
  const { repo } = conflictRepo(t)
  assert.equal(detect(repo), null)
  repo.git(['merge', 'other'], { allowFail: true })
  assert.equal(detect(repo), 'MERGE_HEAD')
})

test('特殊流程：cherry-pick 冲突', (t) => {
  const { repo, otherCommit } = conflictRepo(t)
  repo.git(['cherry-pick', otherCommit], { allowFail: true })
  assert.equal(detect(repo), 'CHERRY_PICK_HEAD')
})

test('特殊流程：多个提交的 cherry-pick 留下 sequencer', (t) => {
  const { repo, otherCommit, other2Commit } = conflictRepo(t)
  repo.git(['cherry-pick', otherCommit, other2Commit], { allowFail: true })
  assert.ok(detect(repo) === 'CHERRY_PICK_HEAD' || detect(repo) === 'sequencer')
  assert.ok(existsSync(repo.gitPath('sequencer')))
})

test('特殊流程：revert 冲突', (t) => {
  const { repo } = conflictRepo(t)
  repo.git(['checkout', '-q', 'other'])
  repo.write('f.txt', 'other3\n'); repo.git(['commit', '-q', '-am', 'other3'])
  const target = repo.git(['rev-parse', 'HEAD~1']).stdout.trim()
  repo.git(['revert', '--no-edit', target], { allowFail: true })
  assert.equal(detect(repo), 'REVERT_HEAD')
})

test('特殊流程：rebase 冲突', (t) => {
  const { repo } = conflictRepo(t)
  repo.git(['rebase', 'other'], { allowFail: true })
  const s = detect(repo)
  assert.ok(s === 'rebase-merge' || s === 'rebase-apply', `实际：${s}`)
})

test('特殊流程：在 linked worktree 中同样正确', (t) => {
  const { repo } = conflictRepo(t, true)
  assert.equal(detect(repo), null)
  repo.git(['merge', 'other'], { allowFail: true })
  assert.equal(detect(repo), 'MERGE_HEAD')
  assert.match(repo.gitPath('MERGE_HEAD'), /worktrees\/wt\/MERGE_HEAD$/)
})

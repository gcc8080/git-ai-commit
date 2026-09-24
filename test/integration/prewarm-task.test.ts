// 第 16–18 组：后台任务、去抖、接管、前台协作、缓存与卸载（D5、D16、D19）。使用打包产物、真实的后台进程与假后端。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Sandbox, type Repo } from '../helpers/repo.ts'
import { BUNDLE, FIXTURES } from '../helpers/paths.ts'
import { writeMachineConfig } from '../helpers/setup.ts'
import { writeShellHook } from '../helpers/hooks.ts'
import { cacheFiles, calls, cli, installWithPrewarm, readyEntries, sleep, stateOf, waitIdle } from '../helpers/prewarm.ts'

const FAKE = join(FIXTURES, 'fake-harness.mjs')

interface Fixture { repo: Repo; id: string; log: string }

function setup(t: { after: (fn: () => void) => void }, machine: Record<string, unknown> = {}, opts: { worktree?: string } = {}): Fixture & { wt?: Repo } {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  writeMachineConfig(sb, { debounceMs: 300, timeoutMs: 15_000, ...machine })
  const repo = sb.repo()
  const wt = opts.worktree ? repo.addWorktree(opts.worktree) : undefined
  const id = installWithPrewarm(repo)
  return { repo, id, log: join(sb.root, 'fake.jsonl'), ...(wt ? { wt } : {}) }
}

let n = 0
function stage(repo: Repo, env: Record<string, string>, name = `f${n++}.txt`) {
  repo.write(name, `${name}\n`)
  repo.git(['add', name], { env })
}

async function until(cond: () => boolean, ms = 15_000, what = '条件') {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`等待${what}超时`)
    await sleep(50)
  }
}

function commit(repo: Repo, env: Record<string, string>, args: string[] = []) {
  return repo.git(['commit', '-q', ...args], { env: { GIT_EDITOR: 'true', ...env }, allowFail: true })
}

const subject = (repo: Repo) => repo.git(['log', '-1', '--format=%s']).stdout.trim()

/** 屏障：除 keep 中列出的检查点外，其余检查点直接放行。 */
function barrierDir(repo: Repo, keep: string[], name = 'barrier'): string {
  const dir = join(repo.sandbox.root, name)
  mkdirSync(dir, { recursive: true })
  for (const name of ['start', 'registered', 'before-lock', 'before-send', 'before-publish']) if (!keep.includes(name)) writeFileSync(join(dir, `${name}.go`), '')
  return dir
}
const arrivals = (dir: string, name: string) => readdirSync(dir).filter((f) => f.startsWith(`${name}.`) && !f.endsWith('.go')).length
const reached = (dir: string, name: string) => arrivals(dir, name) > 0
const release = (dir: string, name: string) => writeFileSync(join(dir, `${name}.go`), '')
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

// ---------- 基本流程与 18.2 ----------

test('预热后提交：提交阶段不新增请求，消息来自缓存（git commit 与 git commit -m 都是）', async (t) => {
  const { repo, id, log } = setup(t)
  const env = { FAKE_LOG: log }
  stage(repo, env)
  await waitIdle(id)
  assert.equal(calls(log).length, 1, '暂存阶段预热一次')
  assert.equal(readyEntries(stateOf(repo, id)).length, 1)
  assert.equal(commit(repo, env).status, 0)
  assert.equal(subject(repo), 'fix: 修复示例问题')
  await waitIdle(id)
  assert.equal(calls(log).length, 1, '提交阶段没有新增请求')

  stage(repo, env)
  await waitIdle(id)
  assert.equal(calls(log).length, 2)
  assert.equal(commit(repo, env, ['-m', 'chore: 手写']).status, 0)
  await waitIdle(id)
  assert.equal(calls(log).length, 2, '显式消息：已预热过的快照不新增请求')
})

// ---------- 16.1 发送前复核 ----------

test('16.1 等待期间撤回了暂存、提交已经完成、预热被关闭：都不发送请求', async (t) => {
  // 用屏障让任务停在登记之后，等操作完成再放行：验证的是发送前的复核，而不是依赖去抖窗口的时序
  // 提交自身写 index 时也会触发一个任务：让它同样停在屏障上，提交完成后一起放行（提交在去抖窗口内完成是尽力而为，见 D15）
  const { repo, id, log } = setup(t)
  const cases: Array<[string, string, (bdir: string) => void]> = [
    ['撤回了暂存', 'a.txt', () => repo.git(['reset', '-q'], { env: { FAKE_LOG: log } })],
    ['提交已经完成（18.2：git commit -m 请求次数为零）', 'b.txt', (bdir) => { assert.equal(commit(repo, { FAKE_LOG: log, AI_COMMIT_TEST_BARRIER: bdir }, ['-m', 'chore: 等待期间完成的提交']).status, 0) }],
    ['预热被关闭', 'c.txt', () => repo.git(['config', 'aicommit.prewarm', 'false'])],
  ]
  for (const [i, [why, file, action]] of cases.entries()) {
    const bdir = barrierDir(repo, ['registered'], `barrier-${i}`)
    stage(repo, { FAKE_LOG: log, AI_COMMIT_TEST_BARRIER: bdir }, file)
    await until(() => reached(bdir, 'registered'), 15_000, `${why}：任务登记`)
    action(bdir)
    release(bdir, 'registered')
    await waitIdle(id)
    assert.equal(calls(log).length, 0, why)
  }
})

// ---------- 16.2 去抖与并发上限 ----------

test('16.2 几秒内连续三次暂存：最终只为最新快照发起一次请求', async (t) => {
  const { repo, id, log } = setup(t)
  const bdir = barrierDir(repo, ['registered'])
  const env = { FAKE_LOG: log, FAKE_LOG_STDIN: '1', AI_COMMIT_TEST_BARRIER: bdir }
  stage(repo, env, 'first.txt')
  stage(repo, env, 'second.txt')
  stage(repo, env, 'third.txt')
  await until(() => arrivals(bdir, 'registered') === 3, 15_000, '三个任务都已登记')
  release(bdir, 'registered')
  await waitIdle(id)
  const cs = calls(log)
  assert.equal(cs.length, 1)
  for (const f of ['first.txt', 'second.txt', 'third.txt']) assert.ok(cs[0]!.stdin!.includes(f), `最新快照包含 ${f}`)
})

test('16.2 新快照取代正在生成的旧任务：任一时刻至多一个后台生成，最终结果对应最新快照', async (t) => {
  const { repo, id, log } = setup(t, { debounceMs: 200 })
  const env = { FAKE_LOG: log, FAKE_SCENARIO: 'slow', FAKE_DELAY_MS: '4000' }
  stage(repo, env, 'old.txt')
  await until(() => calls(log).length === 1, 15_000, '第一次请求')
  const first = calls(log)[0]!
  stage(repo, env, 'new.txt')
  await waitIdle(id)
  const cs = calls(log)
  assert.equal(cs.length, 2)
  assert.deepEqual(cs[1]!.othersAlive, [], '第二次请求开始时，旧任务的后端进程已经退出')
  assert.equal(alive(first.pid), false)
  assert.equal(readyEntries(stateOf(repo, id)).length, 1, '只发布了最新快照的结果')
  assert.equal(commit(repo, { FAKE_LOG: log }).status, 0)
  await waitIdle(id)
  assert.equal(calls(log).length, 2, '提交命中最新快照的缓存')
})

// ---------- 16.5 前台协作 ----------

test('16.5 预热未完成时执行 git commit：前台等待同一快照的任务，整个流程的后端请求总数为一', async (t) => {
  const { repo, id, log } = setup(t, { debounceMs: 200 })
  const env = { FAKE_LOG: log, FAKE_SCENARIO: 'slow', FAKE_DELAY_MS: '2500' }
  stage(repo, env)
  await until(() => calls(log).length === 1, 15_000, '预热请求')
  const r = commit(repo, env)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /正在等待同一快照的预热结果/)
  assert.equal(subject(repo), 'fix: 修复示例问题')
  await waitIdle(id)
  assert.equal(calls(log).length, 1)
})

// ---------- 17.1 缓存键 ----------

test('17.1 修改 diff 显示配置仍然命中；所有修改都已暂存后执行 git commit -a 时命中', async (t) => {
  const { repo, id, log } = setup(t)
  const env = { FAKE_LOG: log }
  repo.write('README.md', '# fixture\n\n更新说明\n')
  stage(repo, env, 'extra.txt')
  repo.git(['add', '-A'], { env })
  await waitIdle(id)
  assert.equal(calls(log).length, 1)
  repo.git(['config', 'diff.noprefix', 'true'])
  repo.git(['config', 'diff.context', '1'])
  assert.equal(commit(repo, env, ['-a']).status, 0)
  await waitIdle(id)
  assert.equal(calls(log).length, 1, 'commit -a 命中预热结果')
})

// ---------- 17.2 条目与校验 ----------

test('17.2 条目损坏时退回同步生成', async (t) => {
  const { repo, id, log } = setup(t)
  const env = { FAKE_LOG: log }
  stage(repo, env)
  await waitIdle(id)
  const p = stateOf(repo, id)
  for (const f of cacheFiles(p)) writeFileSync(join(p.cache, f), '{"v":1,"state":"ready","candidate":')
  assert.equal(commit(repo, env).status, 0)
  assert.equal(subject(repo), 'fix: 修复示例问题')
  await waitIdle(id)
  assert.equal(calls(log).length, 2, '损坏的条目视为未命中')
})

test('17.2 回退产出的结果存在主 profile 的 key 下；命中时诊断中能看到实际后端', async (t) => {
  const { repo, id, log } = setup(t, {
    defaultProfile: 'fake',
    profiles: { fake: { harness: 'claude', model: 'm-primary', executable: FAKE }, fb: { harness: 'claude', model: 'm-fallback', executable: FAKE } },
    fallback: ['fb'],
  })
  stage(repo, { FAKE_LOG: log, FAKE_SCENARIOS: 'quota,candidate' })
  await waitIdle(id)
  assert.equal(calls(log).length, 2)
  assert.equal(readyEntries(stateOf(repo, id))[0]!.producedBy.profile, 'fb')
  const r = commit(repo, { FAKE_LOG: log })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /使用预热结果：由回退后端 fb（claude m-fallback）生成/)
  assert.equal(calls(log).length, 2)
})

// ---------- 17.3 命中路径与强制刷新 ----------

test('17.3 命中路径：直接使用缓存，不发请求（耗时见 test/perf）', async (t) => {
  const { repo, id, log } = setup(t)
  stage(repo, { FAKE_LOG: log })
  await waitIdle(id)
  const msgFile = join(repo.dir, '.git', 'COMMIT_EDITMSG')
  writeFileSync(msgFile, '')
  const r = spawnSync(process.execPath, [BUNDLE, 'hook', 'prepare-commit-msg', '--install-id', id, '--', '.git/COMMIT_EDITMSG', ''], { cwd: repo.dir, env: repo.sandbox.env({ FAKE_LOG: log }), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(readFileSync(msgFile, 'utf8'), /^fix: 修复示例问题/)
  assert.equal(calls(log).length, 1)
})

test('17.3 preview --refresh 与旧任务竞速：终止旧任务后生成，缓存中保留刷新结果', async (t) => {
  const { repo, id, log } = setup(t, { debounceMs: 200 })
  const bdir = barrierDir(repo, ['before-publish'])
  stage(repo, { FAKE_LOG: log, AI_COMMIT_TEST_BARRIER: bdir, FAKE_CANDIDATE: JSON.stringify({ type: 'fix', scope: null, subject: '旧任务的结果', body: [], breakingChange: null }) })
  await until(() => reached(bdir, 'before-publish'), 15_000, '旧任务停在发布之前')
  const oldPid = Number(readdirSync(bdir).find((f) => f.startsWith('before-publish.') && !f.endsWith('.go'))!.split('.')[1])
  const r = cli(repo, ['preview', '--refresh'], { FAKE_LOG: log, FAKE_CANDIDATE: JSON.stringify({ type: 'feat', scope: null, subject: '刷新的结果', body: [], breakingChange: null }) })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'feat: 刷新的结果')
  assert.equal(alive(oldPid), false, '旧任务已被终止')
  release(bdir, 'before-publish')
  await waitIdle(id)
  const entries = readyEntries(stateOf(repo, id))
  assert.deepEqual(entries.map((e) => e.candidate.subject), ['刷新的结果'])
  assert.equal(calls(log).length, 2)
})

// ---------- 18.1 卸载与在途任务 ----------

test('18.1 任务已启动、尚未登记时卸载：放行后请求次数为零，状态目录不被重建', async (t) => {
  const { repo, id, log } = setup(t)
  const bdir = barrierDir(repo, ['start'])
  stage(repo, { FAKE_LOG: log, AI_COMMIT_TEST_BARRIER: bdir })
  await until(() => reached(bdir, 'start'), 15_000, '任务停在登记之前')
  assert.equal(cli(repo, ['uninstall']).status, 0)
  release(bdir, 'start')
  await waitIdle(id)
  assert.equal(calls(log).length, 0)
  assert.equal(existsSync(join(repo.gitPath('ai-commit'), id)), false, '状态目录没有被重建')
})

test('18.1 任务已登记、尚未取得 key 锁时卸载：任务被终止并确认退出，请求次数为零', async (t) => {
  const { repo, id, log } = setup(t)
  const bdir = barrierDir(repo, ['registered'])
  stage(repo, { FAKE_LOG: log, AI_COMMIT_TEST_BARRIER: bdir })
  await until(() => reached(bdir, 'registered'), 15_000, '任务停在去抖之前')
  const taskPid = Number(readdirSync(bdir).find((f) => f.startsWith('registered.'))!.split('.')[1])
  const u = cli(repo, ['uninstall'])
  assert.equal(u.status, 0)
  assert.doesNotMatch(u.stderr, /未能确认退出/)
  assert.equal(alive(taskPid), false)
  release(bdir, 'registered')
  await waitIdle(id)
  assert.equal(calls(log).length, 0)
  assert.equal(existsSync(join(repo.gitPath('ai-commit'), id)), false)
})

test('18.1 正在生成的任务：卸载时连同后端进程一起终止，结果不发布', async (t) => {
  const { repo, id, log } = setup(t, { debounceMs: 200 })
  stage(repo, { FAKE_LOG: log, FAKE_SCENARIO: 'slow', FAKE_DELAY_MS: '8000' })
  await until(() => calls(log).length === 1, 15_000, '请求已发出')
  const backendPid = calls(log)[0]!.pid
  const u = cli(repo, ['uninstall'])
  assert.equal(u.status, 0)
  assert.doesNotMatch(u.stderr, /未能确认退出/)
  assert.equal(alive(backendPid), false, '后端进程随任务的进程组一起终止')
  await waitIdle(id)
  assert.equal(existsSync(join(repo.gitPath('ai-commit'), id)), false)
})

test('18.1 卸载后立即重装：旧任务既进不了新目录，也不能发布结果', async (t) => {
  const { repo, id, log } = setup(t)
  const bdir = barrierDir(repo, ['start'])
  stage(repo, { FAKE_LOG: log, AI_COMMIT_TEST_BARRIER: bdir })
  await until(() => reached(bdir, 'start'), 15_000, '任务停在登记之前')
  assert.equal(cli(repo, ['uninstall']).status, 0)
  const newId = installWithPrewarm(repo)
  assert.notEqual(newId, id)
  release(bdir, 'start')
  await waitIdle(id)
  assert.equal(calls(log).length, 0)
  assert.equal(existsSync(join(repo.gitPath('ai-commit'), id)), false, '旧目录没有被重建')
  assert.deepEqual(cacheFiles(stateOf(repo, newId)), [], '新目录中没有旧任务的结果')
  assert.deepEqual(readdirSync(stateOf(repo, newId).tasks), [], '新目录中没有旧任务的登记')
})

test('18.1 linked worktree 中同样成立', async (t) => {
  const { repo, id, log, wt } = setup(t, {}, { worktree: 'linked' })
  const bdir = barrierDir(repo, ['registered'])
  stage(wt!, { FAKE_LOG: log, AI_COMMIT_TEST_BARRIER: bdir })
  await until(() => reached(bdir, 'registered'), 15_000, 'linked worktree 中的任务停在去抖之前')
  assert.equal(cli(repo, ['uninstall']).status, 0)
  release(bdir, 'registered')
  await waitIdle(id)
  assert.equal(calls(log).length, 0)
  assert.equal(existsSync(join(wt!.gitPath('ai-commit'), id)), false)
})

// ---------- 18.2 显式消息与预热的边界 ----------

test('18.2 AI_COMMIT_SKIP=1 git commit -m：即使 pre-commit hook 很慢，请求次数也为零', async (t) => {
  const { repo, id, log } = setup(t)
  writeShellHook(repo, 'pre-commit', 'sleep 1')
  repo.write('slow.txt', 'x\n')
  repo.git(['add', 'slow.txt'], { env: { FAKE_LOG: log, AI_COMMIT_SKIP: '1' } })
  assert.equal(commit(repo, { FAKE_LOG: log, AI_COMMIT_SKIP: '1' }, ['-m', 'chore: 确定不外发']).status, 0)
  await waitIdle(id)
  assert.equal(calls(log).length, 0)
})

// 7.1 进程执行器
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { Sandbox } from '../helpers/repo.ts'
import { FIXTURES } from '../helpers/paths.ts'
import { execBackend } from '../../src/backend/exec.ts'
import { execFailure } from '../../src/backend/classify.ts'

const FAKE = join(FIXTURES, 'fake-harness.mjs')

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitDead(pid: number, ms = 3000): Promise<boolean> {
  for (let t = 0; t < ms; t += 50) {
    if (!alive(pid)) return true
    await sleep(50)
  }
  return !alive(pid)
}

test('超时：终止整个进程组，后端派生的子进程也被终止', async (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const pidFile = join(sb.root, 'child.pid')
  const started = performance.now()
  const run = execBackend({
    command: FAKE, args: ['-p'], stdin: 'x', deadline: performance.now() + 2500,
    env: sb.env({ FAKE_SCENARIO: 'child', FAKE_CHILD_PID_FILE: pidFile }), killGraceMs: 300,
  })
  // 先确认孙进程已经派生出来，否则这个用例没有意义（高负载下启动可能较慢）
  for (let i = 0; i < 240 && !existsSync(pidFile); i++) await sleep(10)
  assert.ok(existsSync(pidFile), '截止时间之前孙进程已派生')
  const grandchild = Number(readFileSync(pidFile, 'utf8'))
  assert.ok(alive(grandchild))
  const r = await run
  assert.equal(r.timedOut, true)
  assert.ok(performance.now() - started < 6000, '按截止时间返回')
  assert.ok(await waitDead(grandchild), '孙进程已被终止')
  assert.equal(execFailure('p', FAKE, r)!.class, 'timeout')
})

test('取消：终止进程组并标记为已取消', async (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 300)
  const r = await execBackend({ command: FAKE, args: ['-p'], stdin: 'x', deadline: performance.now() + 30_000, signal: ac.signal, env: sb.env({ FAKE_SCENARIO: 'timeout' }), killGraceMs: 300 })
  assert.equal(r.cancelled, true)
  assert.equal(execFailure('p', FAKE, r)!.class, 'cancelled')
})

test('后端把完整输入回显到 stderr：呈现给用户的只有一行分类后的原因', async (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const prompt = 'DIFF-CONTENT-THAT-MUST-NOT-LEAK\n+secret line\n'.repeat(20)
  const r = await execBackend({ command: FAKE, args: ['-p'], stdin: prompt, deadline: performance.now() + 10_000, env: sb.env({ FAKE_SCENARIO: 'echo-stderr' }) })
  assert.ok(r.stderr.includes('DIFF-CONTENT-THAT-MUST-NOT-LEAK'), '后端确实回显了输入')
  const f = execFailure('myprofile', FAKE, r)!
  assert.equal(f.message.includes('\n'), false)
  assert.equal(f.message.includes('DIFF-CONTENT'), false)
  assert.equal(f.message, 'myprofile：调用失败')
})

test('子进程环境：不继承 GIT_* 变量，带重入标记，工作目录是 0700 的临时目录（PWD 与之一致）且调用后被删除', async (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const log = join(sb.root, 'fake.jsonl')
  const r = await execBackend({
    command: FAKE, args: ['-p'], stdin: 'x', deadline: performance.now() + 10_000,
    env: sb.env({ FAKE_LOG: log, GIT_DIR: '/repo/.git', GIT_INDEX_FILE: '/repo/.git/index', GIT_WORK_TREE: '/repo', PWD: '/repo', OLDPWD: '/elsewhere' }),
  })
  assert.equal(r.status, 0)
  const rec = JSON.parse(readFileSync(log, 'utf8').trim()) as { cwd: string; cwdMode: string; env: Record<string, string> }
  assert.deepEqual(Object.keys(rec.env).filter((k) => k.startsWith('GIT_')), [])
  assert.equal(rec.env.AI_COMMIT_ACTIVE, '1')
  assert.equal(rec.cwdMode, '700')
  assert.ok(rec.cwd.includes('ai-commit-'))
  assert.ok(rec.cwd === rec.env.PWD || rec.cwd === `/private${rec.env.PWD}`, `PWD 应指向临时目录，而不是继承来的路径：${rec.env.PWD}`)
  assert.equal(rec.env.OLDPWD, undefined)
  assert.ok(rec.cwd.startsWith(tmpdir()) || rec.cwd.startsWith('/private' + tmpdir()))
  assert.equal(existsSync(rec.cwd), false, '临时目录已删除')
})

test('找不到可执行文件：配置错误', async () => {
  const r = await execBackend({ command: '/nonexistent/claude', args: [], stdin: '', deadline: performance.now() + 5000 })
  assert.equal(r.spawnError, 'ENOENT')
  const f = execFailure('p', '/nonexistent/claude', r)!
  assert.equal(f.class, 'config')
  assert.match(f.message, /找不到后端可执行文件/)
})

test('截止时间已过：不启动进程', async () => {
  const r = await execBackend({ command: FAKE, args: [], stdin: '', deadline: performance.now() - 1 })
  assert.equal(r.timedOut, true)
  assert.equal(r.status, null)
})

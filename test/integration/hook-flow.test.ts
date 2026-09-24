// 第 8 组：prepare-commit-msg 的 shell 模板、主流程与失败语义（使用打包产物 + 假后端）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { Sandbox, type Repo } from '../helpers/repo.ts'
import { running } from '../helpers/proc.ts'
import { BUNDLE } from '../helpers/paths.ts'
import { COUNTER, installPrepareHook, lineCount, writeMachineConfig } from '../helpers/setup.ts'

function setup(t: { after: (fn: () => void) => void }, machine: Record<string, unknown> = {}) {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const repo = sb.repo()
  writeMachineConfig(sb, machine)
  return repo
}

function stage(repo: Repo) {
  repo.write(`f-${Math.random().toString(36).slice(2)}.txt`, 'content\n')
  repo.git(['add', '-A'])
}

const head = (repo: Repo) => repo.git(['rev-parse', 'HEAD']).stdout.trim()

// ---------- 8.1 shell 模板与入口计数 ----------

test('8.1 入口计数：-m、跳过开关、重入标记、重用消息都不启动主程序；普通提交启动一次', (t) => {
  const repo = setup(t)
  const count = join(repo.sandbox.root, 'count.log')
  installPrepareHook(repo, { script: COUNTER })
  const env = { COUNTER_FILE: count, GIT_EDITOR: 'true' }
  const cases: Array<[string, string[], Record<string, string>, number]> = [
    ['-m', ['-m', 'x'], {}, 0],
    ['跳过开关', ['--allow-empty-message'], { AI_COMMIT_SKIP: '1' }, 0],
    ['重入标记', ['--allow-empty-message'], { AI_COMMIT_ACTIVE: '1' }, 0],
    ['--amend', ['--amend', '--no-edit'], {}, 0],
    ['-C HEAD', ['-C', 'HEAD'], {}, 0],
    ['普通提交', ['--allow-empty-message'], {}, 1],
  ]
  for (const [name, args, extra, expected] of cases) {
    writeFileSync(count, '')
    stage(repo)
    repo.git(['commit', '-q', ...args], { env: { ...env, ...extra }, allowFail: true })
    assert.equal(lineCount(count), expected, name)
  }
})

test('8.1 模板里已有标题：主程序启动一次，判定已有正文后放行，后端调用次数为零', (t) => {
  const repo = setup(t)
  const tmpl = repo.write('../title.tmpl', 'fix: preserve my intended message\n')
  // 用计数入口数主程序启动次数
  const count = join(repo.sandbox.root, 'count.log')
  installPrepareHook(repo, { script: COUNTER })
  stage(repo)
  repo.git(['commit', '-q', '-t', tmpl, '--allow-empty-message', '--no-edit'], { env: { COUNTER_FILE: count }, allowFail: true })
  assert.equal(lineCount(count), 1)
  // 换成真实主程序：后端调用次数为零，模板标题原样提交
  const log = join(repo.sandbox.root, 'fake.log')
  installPrepareHook(repo)
  stage(repo)
  const r = repo.git(['commit', '-q', '-t', tmpl, '--allow-empty-message', '--no-edit'], { env: { FAKE_LOG: log }, allowFail: true })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(lineCount(log), 0)
  assert.equal(repo.git(['log', '-1', '--format=%s']).stdout.trim(), 'fix: preserve my intended message')
})

test('8.1 运行时路径失效：输出一行诊断并以 0 退出，不启动主程序', (t) => {
  const repo = setup(t)
  installPrepareHook(repo, { node: '/nonexistent/node' })
  stage(repo)
  const r = repo.git(['commit', '-q', '-m', 'x'], { allowFail: true })
  assert.equal(r.status, 0, '-m 在 shell 中即已放行')
  stage(repo)
  const r2 = repo.git(['commit', '--allow-empty-message', '--no-edit'], { allowFail: true })
  assert.match(r2.stderr, /ai-commit: 运行时路径已失效（\/nonexistent\/node）/)
  assert.equal(r2.stderr.split('\n').filter((l) => l.startsWith('ai-commit:')).length, 1)
  assert.equal(r2.status, 0, '回到 Git 原生行为：允许空消息时照常提交')
})

// ---------- 8.2 主流程与失败语义 ----------

test('8.2 成功：候选被渲染并写入，Git 用它完成提交', (t) => {
  const repo = setup(t)
  installPrepareHook(repo)
  stage(repo)
  const cand = { type: 'feat', scope: 'demo', subject: '新增示例', body: ['第一条'], breakingChange: null }
  const r = repo.git(['commit', '-q', '--no-edit'], { env: { FAKE_CANDIDATE: JSON.stringify(cand) }, allowFail: true })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(repo.git(['log', '-1', '--format=%B']).stdout.trim(), 'feat(demo): 新增示例\n\n- 第一条')
})

function runHookDirect(repo: Repo, env: Record<string, string>, msg = '') {
  const msgFile = join(repo.dir, '.git', 'COMMIT_EDITMSG')
  writeFileSync(msgFile, msg)
  const r = spawnSync(process.execPath, [BUNDLE, 'hook', 'prepare-commit-msg', '--install-id', 't', '--', '.git/COMMIT_EDITMSG', ''], {
    cwd: repo.dir, env: repo.sandbox.env(env), encoding: 'utf8', timeout: 60_000,
  })
  return { status: r.status, stderr: r.stderr, msg: readFileSync(msgFile, 'utf8') }
}

const failures: Array<[string, Record<string, string>, RegExp]> = [
  ['后端非零退出', { FAKE_SCENARIO: 'nonzero' }, /生成失败，保留原消息：fake：调用失败/],
  ['额度耗尽', { FAKE_SCENARIO: 'quota' }, /fake：额度已耗尽/],
  ['未登录', { FAKE_SCENARIO: 'auth' }, /fake：未登录或认证已失效/],
  ['输出被截断', { FAKE_SCENARIO: 'truncate' }, /fake：调用失败/],
  ['纠正后仍不合规', { FAKE_SCENARIOS: 'invalid,invalid' }, /纠正一次后输出仍不合规/],
  ['模型拒绝', { FAKE_SCENARIO: 'refusal' }, /模型认为证据不足，拒绝生成/],
  ['回显输入', { FAKE_SCENARIO: 'echo-stderr' }, /fake：调用失败/],
]
for (const [name, env, pattern] of failures) {
  test(`8.2 失败（${name}）：消息文件不变，一行诊断，以 0 退出`, (t) => {
    const repo = setup(t)
    stage(repo)
    const original = '\n# Please enter the commit message\n'
    const log = join(repo.sandbox.root, 'fake.log')
    const r = runHookDirect(repo, { ...env, FAKE_LOG: log }, original)
    assert.equal(r.status, 0)
    assert.equal(r.msg, original)
    // 进度提示与未验证版本的提示之外，失败原因只有一行
    const diag = r.stderr.split('\n').filter((l) => l.startsWith('ai-commit:') && !l.includes('正在用') && !l.includes('未验证状态'))
    assert.equal(diag.length, 1, r.stderr)
    assert.match(diag[0]!, pattern)
    assert.equal(r.stderr.includes('Please enter'), false, '不回显 prompt 或 diff')
    assert.match(r.stderr, /^ai-commit: 正在用 fake 生成提交信息…$/m, '非 TTY：进度提示只有一行')
    assert.equal(/[\x1b\r]/.test(r.stderr), false, '非 TTY 时不输出控制字符')
  })
}

test('8.2 超时：受总预算约束，消息文件不变', (t) => {
  const repo = setup(t, { timeoutMs: 1500 })
  stage(repo)
  const started = performance.now()
  const r = runHookDirect(repo, { FAKE_SCENARIO: 'timeout' })
  assert.ok(performance.now() - started < 8000)
  assert.equal(r.status, 0)
  assert.equal(r.msg, '')
  assert.match(r.stderr, /fake：超时/)
})

test('8.2 未配置 profile：一行诊断并以 0 退出', (t) => {
  const repo = setup(t, { defaultProfile: null })
  stage(repo)
  const r = runHookDirect(repo, {})
  assert.equal(r.status, 0)
  assert.match(r.stderr, /未配置 profile/)
})

test('8.2 用户取消（SIGINT）：以非零退出，不重试、不回退，后端进程被终止', async (t) => {
  const repo = setup(t)
  stage(repo)
  const log = join(repo.sandbox.root, 'fake.log')
  writeFileSync(join(repo.dir, '.git', 'COMMIT_EDITMSG'), '')
  const child = spawn(process.execPath, [BUNDLE, 'hook', 'prepare-commit-msg', '--install-id', 't', '--', '.git/COMMIT_EDITMSG', ''], {
    cwd: repo.dir, env: repo.sandbox.env({ FAKE_SCENARIO: 'timeout', FAKE_LOG: log }), stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)))
  for (let i = 0; i < 200 && lineCount(log) === 0; i++) await sleep(25)
  assert.equal(lineCount(log), 1, '后端已被调用')
  const backendPid = (JSON.parse(readFileSync(log, 'utf8').trim()) as { pid: number }).pid
  child.kill('SIGINT')
  const code = await exited
  assert.equal(code, 130)
  assert.match(stderr, /已取消/)
  assert.equal(lineCount(log), 1, '没有重试或回退')
  await sleep(1500)
  assert.equal(running(backendPid), false, '后端进程已被终止')
})

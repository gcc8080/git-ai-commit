// 14.3 递归防护：主程序自身检查重入标记与跳过开关（经管理器手动接入时不经过 shell 模板）；
// 后端子进程保留重入标记，也保留后端自己的保护性环境变量（例如 Claude Code 的 CLAUDECODE）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Sandbox, type Repo } from '../helpers/repo.ts'
import { BUNDLE } from '../helpers/paths.ts'
import { FAKE, lineCount, writeMachineConfig } from '../helpers/setup.ts'
import { manualPrepareLine } from '../../src/hook/templates.ts'
import { execBackend } from '../../src/backend/exec.ts'
import { envSkip } from '../../src/hook/prepare.ts'

function setup(t: { after: (fn: () => void) => void }) {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const repo = sb.repo()
  writeMachineConfig(sb)
  repo.write('a.txt', 'a\n')
  repo.git(['add', '-A'])
  return repo
}

function runMain(repo: Repo, env: Record<string, string>) {
  const msgFile = join(repo.dir, '.git', 'COMMIT_EDITMSG')
  writeFileSync(msgFile, '')
  const log = join(repo.sandbox.root, 'fake.log')
  const r = spawnSync(process.execPath, [BUNDLE, 'hook', 'prepare-commit-msg', '--install-id', 't', '--', '.git/COMMIT_EDITMSG', ''], {
    cwd: repo.dir, env: repo.sandbox.env({ FAKE_LOG: log, ...env }), encoding: 'utf8', timeout: 60_000,
  })
  return { status: r.status, msg: readFileSync(msgFile, 'utf8'), calls: lineCount(log) }
}

test('envSkip：与 shell 模板的放行条件一致', () => {
  assert.equal(envSkip({}), null)
  assert.equal(envSkip({ AI_COMMIT_SKIP: '0' }), null)
  assert.equal(envSkip({ AI_COMMIT_SKIP: '' }), null)
  assert.match(envSkip({ AI_COMMIT_SKIP: '1' })!, /跳过开关/)
  assert.match(envSkip({ AI_COMMIT_SKIP: 'yes' })!, /跳过开关/)
  assert.match(envSkip({ AI_COMMIT_ACTIVE: '1' })!, /重入标记/)
})

for (const [name, env, expectCalls] of [
  ['带重入标记', { AI_COMMIT_ACTIVE: '1' }, 0],
  ['跳过开关', { AI_COMMIT_SKIP: '1' }, 0],
  ['跳过开关为 0', { AI_COMMIT_SKIP: '0' }, 1],
] as const) {
  test(`主程序直接被调用（${name}）：后端调用 ${expectCalls} 次`, (t) => {
    const repo = setup(t)
    const r = runMain(repo, env)
    assert.equal(r.status, 0)
    assert.equal(r.calls, expectCalls)
    assert.equal(r.msg === '', expectCalls === 0)
  })
}

test('管理器式接入（手动接入行）：带重入标记的 git commit 不触发生成', (t) => {
  const repo = setup(t)
  const hook = join(repo.gitPath('hooks'), 'prepare-commit-msg')
  writeFileSync(hook, `#!/bin/sh\n# 模拟 Husky 等管理器中的一行接入\n${manualPrepareLine({ node: process.execPath, script: BUNDLE, installId: 'manual' })}\n`)
  chmodSync(hook, 0o755)
  const log = join(repo.sandbox.root, 'fake.log')
  const nested = repo.git(['commit', '-q', '--allow-empty-message', '--no-edit'], { env: { FAKE_LOG: log, AI_COMMIT_ACTIVE: '1' }, allowFail: true })
  assert.equal(nested.status, 0)
  assert.equal(lineCount(log), 0, '重入时后端调用次数为零')
  repo.write('b.txt', 'b\n')
  repo.git(['add', '-A'])
  repo.git(['commit', '-q', '--no-edit'], { env: { FAKE_LOG: log } })
  assert.equal(lineCount(log), 1)
  assert.match(repo.git(['log', '-1', '--format=%s']).stdout, /^fix: 修复示例问题/)
})

test('后端子进程：带重入标记，并保留后端自己的保护性环境变量', async (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const log = join(sb.root, 'fake.jsonl')
  await execBackend({
    command: FAKE, args: ['-p'], stdin: 'x', deadline: performance.now() + 10_000,
    env: sb.env({ FAKE_LOG: log, CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' }),
  })
  const rec = JSON.parse(readFileSync(log, 'utf8').trim()) as { env: Record<string, string> }
  assert.equal(rec.env.AI_COMMIT_ACTIVE, '1')
  assert.equal(rec.env.CLAUDECODE, '1')
  assert.equal(rec.env.CLAUDE_CODE_ENTRYPOINT, 'cli')
})

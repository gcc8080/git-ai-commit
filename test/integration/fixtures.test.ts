// 1.4 的示例：夹具仓库 + 计数入口 + 假后端都能用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Sandbox } from '../helpers/repo.ts'
import { FIXTURES } from '../helpers/paths.ts'

test('夹具仓库中完成 git commit，并读到诊断入口的启动次数', (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const repo = sb.repo()
  const counterFile = join(sb.root, 'count.jsonl')
  const hook = join(repo.dir, '.git', 'hooks', 'prepare-commit-msg')
  writeFileSync(hook, `#!/bin/sh\nexec "${process.execPath}" "${join(FIXTURES, 'counter.mjs')}" "$@"\n`)
  chmodSync(hook, 0o755)

  repo.write('a.txt', 'hello\n')
  repo.git(['add', 'a.txt'])
  repo.git(['commit', '-q', '-m', 'add a'], { env: { COUNTER_FILE: counterFile } })

  const lines = readFileSync(counterFile, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  const rec = JSON.parse(lines[0]!) as { argv: string[] }
  assert.equal(rec.argv[1], 'message', 'git 以 message 来源调用 prepare-commit-msg')
})

test('夹具隔离了全局配置：commit.template 不来自本机', (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const repo = sb.repo()
  const r = repo.git(['config', '--get', 'commit.template'], { allowFail: true })
  assert.notEqual(r.status, 0, '夹具中不应存在 commit.template')
})

test('假后端：candidate 输出 claude envelope，并记录调用', (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const log = join(sb.root, 'fake.jsonl')
  const r = spawnSync(join(FIXTURES, 'fake-harness.mjs'), ['-p', '--output-format', 'json', '--json-schema', '{}'], {
    input: 'prompt text', encoding: 'utf8', env: sb.env({ FAKE_LOG: log }),
  })
  assert.equal(r.status, 0)
  const env = JSON.parse(r.stdout) as { structured_output: { type: string } }
  assert.equal(env.structured_output.type, 'fix')
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1)
})

test('假后端：场景序列按调用次数取用', (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const log = join(sb.root, 'fake.jsonl')
  const env = sb.env({ FAKE_LOG: log, FAKE_SCENARIOS: 'nonzero,candidate' })
  const first = spawnSync(join(FIXTURES, 'fake-harness.mjs'), ['-p'], { input: '', encoding: 'utf8', env })
  const second = spawnSync(join(FIXTURES, 'fake-harness.mjs'), ['-p'], { input: '', encoding: 'utf8', env })
  assert.equal(first.status, 3)
  assert.equal(second.status, 0)
})

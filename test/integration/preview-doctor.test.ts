// 第 10 组：preview 与 doctor
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { Sandbox, type Repo } from '../helpers/repo.ts'
import { BUNDLE } from '../helpers/paths.ts'
import { installPrepareHook, lineCount, writeMachineConfig } from '../helpers/setup.ts'
import { parseRecordedPaths, prepareCommitMsgTemplate } from '../../src/hook/templates.ts'

function cli(repo: Repo, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { cwd: repo.dir, env: repo.sandbox.env(env), encoding: 'utf8', timeout: 60_000 })
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr }
}

function setup(t: { after: (fn: () => void) => void }, machine: Record<string, unknown> = {}) {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  writeMachineConfig(sb, machine)
  return sb.repo()
}

test('10.1 preview：输出生成的消息；HEAD 与暂存区都不变', (t) => {
  const repo = setup(t)
  repo.write('a.txt', 'a\n'); repo.git(['add', '.'])
  const head = repo.git(['rev-parse', 'HEAD']).stdout
  const tree = repo.git(['write-tree']).stdout
  const cand = { type: 'feat', scope: null, subject: '预览示例', body: [], breakingChange: null }
  const r = cli(repo, ['preview'], { FAKE_CANDIDATE: JSON.stringify(cand) })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'feat: 预览示例')
  assert.equal(repo.git(['rev-parse', 'HEAD']).stdout, head)
  assert.equal(repo.git(['write-tree']).stdout, tree)
  assert.equal(repo.git(['diff', '--cached', '--name-only']).stdout.trim(), 'a.txt')
})

test('10.1 preview：--profile 覆盖；暂存为空时提示；生成失败时非零退出', (t) => {
  const repo = setup(t, { profiles: { fake: { harness: 'claude', model: 'm', executable: join(process.cwd(), 'test/fixtures/fake-harness.mjs') }, other: { harness: 'claude', model: 'm2', executable: join(process.cwd(), 'test/fixtures/fake-harness.mjs') } } })
  const empty = cli(repo, ['preview'])
  assert.equal(empty.status, 1)
  assert.match(empty.stderr, /没有可预览的内容/)
  repo.write('a.txt', 'a\n'); repo.git(['add', '.'])
  const log = join(repo.sandbox.root, 'fake.log')
  const r = cli(repo, ['preview', '--profile', 'other'], { FAKE_LOG: log })
  assert.equal(r.status, 0, r.stderr)
  assert.ok((JSON.parse(readFileSync(log, 'utf8').trim()) as { argv: string[] }).argv.includes('m2'))
  const f = cli(repo, ['preview'], { FAKE_SCENARIO: 'quota' })
  assert.equal(f.status, 1)
  assert.match(f.stderr, /额度已耗尽/)
})

test('10.2 doctor：配置正常时无问题，且不发起模型请求', (t) => {
  const repo = setup(t)
  installPrepareHook(repo)
  const log = join(repo.sandbox.root, 'fake.log')
  const r = cli(repo, ['doctor'], { FAKE_LOG: log })
  assert.equal(r.status, 0, r.stdout)
  assert.match(r.stdout, /✓ Node \d+/)
  assert.match(r.stdout, /✓ prepare-commit-msg：已安装/)
  assert.match(r.stdout, /✓ 当前 profile：fake（来自 defaultProfile）/)
  assert.match(r.stdout, /回退链：未配置（默认不回退）/)
  assert.match(r.stdout, /未发现问题/)
  assert.equal(lineCount(log), 0, '诊断期间后端调用次数为零')
})

test('10.2 doctor：hook 中记录的 Node 路径失效时报告，并给出重新安装的修复方式', (t) => {
  const repo = setup(t)
  installPrepareHook(repo, { node: '/nonexistent/node' })
  const log = join(repo.sandbox.root, 'fake.log')
  const r = cli(repo, ['doctor'], { FAKE_LOG: log })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /✗ prepare-commit-msg：记录的 Node 路径已失效：\/nonexistent\/node/)
  assert.match(r.stdout, /修复：重新执行 git ai-commit install/)
  assert.equal(lineCount(log), 0)
})

test('10.2 doctor：未配置本机配置、仓库配置含被拒字段时逐项报告', (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const repo = sb.repo()
  repo.write('.ai-commit.json', JSON.stringify({ prewarm: true, language: 'en' }))
  const r = cli(repo, ['doctor'])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /✗ 本机配置不存在/)
  assert.match(r.stdout, /✗ 未配置 profile/)
  assert.match(r.stdout, /拒绝字段 "prewarm"/)
  assert.match(r.stdout, /语言 en/)
})

test('模板记录的路径可以被读回，包括空格与单引号', () => {
  const content = prepareCommitMsgTemplate({ node: "/opt/my node/bin/node", script: "/Users/o'brien/dist/x.js", installId: 'abc' })
  assert.deepEqual(parseRecordedPaths(content), { node: '/opt/my node/bin/node', script: "/Users/o'brien/dist/x.js" })
})

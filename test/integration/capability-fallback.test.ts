// 13.1 能力探测与兼容性三态、14.1 回退链（使用假后端）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, readFileSync, utimesSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Sandbox, type Repo } from '../helpers/repo.ts'
import { BUNDLE } from '../helpers/paths.ts'
import { FAKE, writeMachineConfig } from '../helpers/setup.ts'
import { cacheFile, evaluate, hasFlag, parseUnknownKeys, parseVersion, probeCapability, HELP_SPEC } from '../../src/backend/capability.ts'
import { captureSnapshot } from '../../src/git/snapshot.ts'
import { loadContext } from '../../src/commands/context.ts'
import { FALLBACK_RESERVE, runGeneration, type FlowResult } from '../../src/commands/generate-flow.ts'
import type { Profile } from '../../src/config/machine.ts'

const claude = (over: Partial<Profile> = {}): Profile => ({ name: 'fake', harness: 'claude', model: 'fake-model', provider: null, effort: null, executable: FAKE, ...over })
const soon = () => ({ deadline: performance.now() + 15_000 })

interface Rec { scenario: string; probe?: string; argv: string[]; env: Record<string, string | undefined> }
const readLog = (file: string): Rec[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec) : [])
const modelOf = (r: Rec) => r.argv[r.argv.indexOf('--model') + 1]

// ---------- 13.1 探测 ----------

test('帮助文本中的参数识别：整词匹配，不被前缀或更长的参数误判', () => {
  const help = '  -p, --print  非交互\n  --tools <tools...>\n  --model=<m>\n  [--safe-mode]\n  --no-session-persistence-extra  x\n'
  assert.equal(hasFlag(help, '--print'), true)
  assert.equal(hasFlag(help, '--tools'), true)
  assert.equal(hasFlag(help, '--model'), true)
  assert.equal(hasFlag(help, '--safe-mode'), true)
  assert.equal(hasFlag(help, '--no-session-persistence'), false)
  assert.equal(hasFlag(help, '--tool'), false)
})

test('版本号解析', () => {
  assert.equal(parseVersion('2.1.281 (Claude Code)'), '2.1.281')
  assert.equal(parseVersion('codex-cli 0.156.1'), '0.156.1')
  assert.equal(parseVersion('1.18.32\n'), '1.18.32')
  assert.equal(parseVersion('1.2.3-beta.1'), '1.2.3-beta.1')
  assert.equal(parseVersion('dev build'), null)
})

test('codex --strict-config 报错中的未识别配置键', () => {
  assert.deepEqual(parseUnknownKeys('Error loading config.toml: unknown configuration field `features.shell_tool` in -c/--config override'), ['features.shell_tool'])
  assert.deepEqual(parseUnknownKeys('Error loading config.toml: unknown variant `disabled`, expected one of `on`, `off` in `web_search`'), ['web_search'])
  assert.deepEqual(parseUnknownKeys('No prompt provided via stdin.'), [])
})

test('三态判定：参数齐全且版本在基线内、没有待核实项才是兼容；参数存在不能让版本变为兼容', () => {
  const flags = [...HELP_SPEC.claude.flags]
  const p = claude()
  assert.equal(evaluate(p, FAKE, { version: '1.0.0', flags, unknownKeys: [] }, { versions: ['1.0.0'], pending: [] }).state, 'compatible')
  assert.equal(evaluate(p, FAKE, { version: '1.0.0', flags, unknownKeys: [] }, { versions: ['1.0.0'], pending: ['x'] }).state, 'unverified')
  assert.equal(evaluate(p, FAKE, { version: '1.0.1', flags, unknownKeys: [] }, { versions: ['1.0.0'], pending: [] }).state, 'unverified')
  assert.equal(evaluate(p, FAKE, { version: null, flags, unknownKeys: [] }, { versions: ['1.0.0'], pending: [] }).state, 'unverified')
  const missing = evaluate(p, FAKE, { version: '1.0.0', flags: flags.filter((f) => f !== '--tools'), unknownKeys: [] }, { versions: ['1.0.0'], pending: [] })
  assert.equal(missing.state, 'incompatible')
  assert.deepEqual(missing.missing, ['--tools'])
})

test('假后端：参数齐全但版本不在基线内 → 未验证', async (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const c = await probeCapability(claude(), sb.env({ FAKE_VERSION: 'fake-claude 9.9.9' }), soon())
  assert.equal(c.state, 'unverified')
  assert.equal(c.version, '9.9.9')
  assert.match(c.reasons.join('；'), /版本 9\.9\.9 不在合同测试基线内/)
})

test('假后端：缺少必需的限制参数 → 不兼容，并列出缺少的参数', async (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const c = await probeCapability(claude(), sb.env({ FAKE_HELP_OMIT: '--safe-mode,--strict-mcp-config' }), soon())
  assert.equal(c.state, 'incompatible')
  assert.deepEqual(c.missing, ['--safe-mode', '--strict-mcp-config'])
})

test('effort 对应的参数只在 profile 设置了 effort 时才是必需的', async (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const env = sb.env({ FAKE_HELP_OMIT: '--effort' })
  assert.equal((await probeCapability(claude(), env, soon())).state, 'unverified')
  const withEffort = await probeCapability(claude({ effort: 'low' }), env, soon())
  assert.equal(withEffort.state, 'incompatible')
  assert.deepEqual(withEffort.missing, ['--effort'])
})

test('codex：--strict-config 在隔离的 CODEX_HOME 中核对配置键，未识别的键 → 不兼容', async (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const probeLog = join(sb.root, 'probe.jsonl')
  const codex = claude({ harness: 'codex', model: 'gpt-5.5' })
  const ok = await probeCapability(codex, sb.env({ FAKE_HARNESS: 'codex', FAKE_PROBE_LOG: probeLog }), soon())
  assert.equal(ok.state, 'unverified')
  const strict = readLog(probeLog).find((r) => r.probe === 'strict-config')!
  assert.ok(strict, '执行了 --strict-config 探测')
  assert.ok(strict.env.CODEX_HOME!.includes('ai-commit-'), 'CODEX_HOME 指向临时目录')
  assert.ok(!strict.env.CODEX_HOME!.startsWith(sb.home))
  for (const key of ['features.shell_tool=false', 'features.hooks=false', 'features.plugins=false', 'web_search="disabled"', 'approval_policy="never"']) assert.ok(strict.argv.includes(key), key)

  const sb2 = new Sandbox()
  t.after(() => sb2.cleanup())
  const bad = await probeCapability(codex, sb2.env({ FAKE_HARNESS: 'codex', FAKE_CODEX_UNKNOWN_KEYS: 'features.shell_tool' }), soon())
  assert.equal(bad.state, 'incompatible')
  assert.deepEqual(bad.missing, ['配置键 features.shell_tool'])
})

test('探测结果按可执行文件身份缓存：命中时不再启动进程，可执行文件变化后重新探测', async (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const exe = join(sb.root, 'claude')
  copyFileSync(FAKE, exe)
  chmodSync(exe, 0o755)
  const probeLog = join(sb.root, 'probe.jsonl')
  const env = sb.env({ FAKE_PROBE_LOG: probeLog })
  const p = claude({ executable: exe })
  await probeCapability(p, env, soon())
  assert.equal(readLog(probeLog).length, 2, '首次探测：--version 与 --help')
  assert.ok(existsSync(cacheFile(env)))
  assert.ok(cacheFile(env).startsWith(sb.home), '缓存位于本机缓存目录')
  await probeCapability(p, env, soon())
  assert.equal(readLog(probeLog).length, 2, '命中缓存')
  utimesSync(exe, new Date(), new Date(Date.now() + 5000))
  await probeCapability(p, env, soon())
  assert.equal(readLog(probeLog).length, 4, '可执行文件变化后重新探测')
  await probeCapability(p, env, { ...soon(), fresh: true })
  assert.equal(readLog(probeLog).length, 6, 'fresh 忽略缓存')
})

test('读不到帮助文本：判为不兼容，且不写入缓存', async (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const exe = join(sb.root, 'broken')
  writeFileSync(exe, '#!/bin/sh\nexit 1\n')
  chmodSync(exe, 0o755)
  const env = sb.env()
  const c = await probeCapability(claude({ executable: exe }), env, soon())
  assert.equal(c.state, 'incompatible')
  assert.deepEqual(c.reasons, ['无法读取帮助文本'])
  assert.equal(existsSync(cacheFile(env)), false)
})

test('找不到可执行文件：不兼容且 executable 为空', async (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const c = await probeCapability(claude({ executable: join(sb.root, 'nope') }), sb.env(), soon())
  assert.equal(c.state, 'incompatible')
  assert.equal(c.executable, null)
})

// ---------- 生成流程：三态与回退 ----------

const PRIMARY = { harness: 'claude', model: 'm-primary', executable: FAKE }
const SECONDARY = { harness: 'claude', model: 'm-fallback', executable: FAKE }

function flowRepo(t: { after: (fn: () => void) => void }, machine: Record<string, unknown> = {}) {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const repo = sb.repo()
  writeMachineConfig(sb, { defaultProfile: 'primary', profiles: { primary: PRIMARY, secondary: SECONDARY }, ...machine })
  repo.write('a.txt', 'hello\n')
  repo.git(['add', '-A'])
  return repo
}

async function flow(repo: Repo, env: Record<string, string>, signal = new AbortController().signal) {
  const log = join(repo.sandbox.root, 'fake.jsonl')
  const ctx = loadContext(repo.dir, repo.sandbox.env({ FAKE_LOG: log, ...env }))
  const notices: string[] = []
  const started = performance.now()
  const r: FlowResult = await runGeneration(ctx, captureSnapshot(ctx.git), { signal, onNotice: (m) => notices.push(m) })
  return { r, notices, calls: readLog(log).map(modelOf), ms: performance.now() - started }
}

test('未验证版本：照常调用，并在诊断中注明', async (t) => {
  const repo = flowRepo(t)
  const { r, notices, calls } = await flow(repo, {})
  assert.equal(r.ok, true)
  assert.deepEqual(calls, ['m-primary'])
  assert.equal(notices.length, 1)
  assert.match(notices[0]!, /primary：claude 0\.0\.1 为未验证状态，照常调用/)
})

test('严格模式：未验证版本不调用，也不回退', async (t) => {
  const repo = flowRepo(t, { strict: true, fallback: ['secondary'] })
  const { r, calls } = await flow(repo, { FAKE_SCENARIO: 'candidate' })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.failure.class, 'incompatible')
    assert.match(r.failure.message, /严格模式下拒绝调用/)
  }
  assert.deepEqual(calls, [])
})

test('不兼容：既不调用也不回退', async (t) => {
  const repo = flowRepo(t, { fallback: ['secondary'] })
  const { r, calls } = await flow(repo, { FAKE_HELP_OMIT: '--tools' })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.failure.class, 'incompatible')
    assert.match(r.failure.message, /不兼容（缺少必需的限制参数：--tools），不调用/)
  }
  assert.deepEqual(calls, [])
})

test('未配置回退链：首选额度耗尽时，第二后端的调用次数为零', async (t) => {
  const repo = flowRepo(t)
  const { r, calls } = await flow(repo, { FAKE_SCENARIO: 'quota' })
  assert.equal(r.ok ? null : r.failure.class, 'quota')
  assert.deepEqual(calls, ['m-primary'])
})

test('已配置回退链：首选额度耗尽时切换一次，并在诊断中注明实际后端', async (t) => {
  const repo = flowRepo(t, { fallback: ['secondary'] })
  const { r, notices, calls } = await flow(repo, { FAKE_SCENARIOS: 'quota,candidate' })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.backend, 'secondary')
    assert.equal(r.fallbackFrom, 'primary')
  }
  assert.deepEqual(calls, ['m-primary', 'm-fallback'])
  assert.ok(notices.some((n) => /primary：额度已耗尽；改用回退后端 secondary/.test(n)), notices.join('\n'))
  assert.ok(notices.some((n) => /本次提交信息由回退后端 secondary 生成/.test(n)))
})

test('回退至多一次：回退后端也失败时不再切换', async (t) => {
  const repo = flowRepo(t, { fallback: ['secondary', 'primary'], profiles: { primary: PRIMARY, secondary: SECONDARY, third: { ...SECONDARY, model: 'm-third' } } })
  const { r, calls } = await flow(repo, { FAKE_SCENARIOS: 'quota,quota,candidate' })
  assert.equal(r.ok, false)
  assert.deepEqual(calls, ['m-primary', 'm-fallback'])
})

test('回退链跳过与首选相同的项', async (t) => {
  const repo = flowRepo(t, { fallback: ['primary', 'secondary'] })
  const { r, calls } = await flow(repo, { FAKE_SCENARIOS: 'auth,candidate' })
  assert.equal(r.ok, true)
  assert.deepEqual(calls, ['m-primary', 'm-fallback'])
})

test('未认证允许回退，诊断中提示重新登录', async (t) => {
  const repo = flowRepo(t, { fallback: ['secondary'] })
  const { r, notices } = await flow(repo, { FAKE_SCENARIOS: 'auth,candidate' })
  assert.equal(r.ok, true)
  assert.ok(notices.some((n) => /请在该 CLI 中重新登录；改用回退后端 secondary/.test(n)), notices.join('\n'))
})

for (const [name, env, cls, expectedCalls] of [
  ['其他调用失败', { FAKE_SCENARIO: 'nonzero' }, 'unknown', ['m-primary']],
  ['纠正后仍不合规', { FAKE_SCENARIOS: 'invalid,invalid,candidate' }, 'invalid-output', ['m-primary', 'm-primary']],
  ['模型拒绝', { FAKE_SCENARIO: 'refusal' }, 'refusal', ['m-primary']],
] as const) {
  test(`${name}：不回退`, async (t) => {
    const repo = flowRepo(t, { fallback: ['secondary'] })
    const { r, calls } = await flow(repo, env)
    assert.equal(r.ok ? null : r.failure.class, cls)
    assert.deepEqual(calls, expectedCalls)
  })
}

test('模型标识无效（配置错误）：不回退', async (t) => {
  const repo = flowRepo(t, {
    fallback: ['secondary'],
    profiles: { primary: { harness: 'pi', provider: 'openai-codex', model: 'gpt-5', executable: FAKE }, secondary: { harness: 'pi', provider: 'openai-codex', model: 'gpt-5.5', executable: FAKE } },
  })
  const { r, calls } = await flow(repo, { FAKE_HARNESS: 'pi', FAKE_PI_MODELS: 'openai-codex/gpt-5.5' })
  assert.equal(r.ok ? null : r.failure.class, 'config')
  assert.deepEqual(calls, [])
})

test('用户取消：不回退', async (t) => {
  const repo = flowRepo(t, { fallback: ['secondary'] })
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 1500)
  const { r, calls } = await flow(repo, { FAKE_SCENARIO: 'slow', FAKE_DELAY_MS: '10000' }, ac.signal)
  assert.equal(r.ok ? null : r.failure.class, 'cancelled')
  assert.deepEqual(calls, ['m-primary'])
})

test('首选超时后回退：首选最多用掉预算的一部分，回退与首选共用同一个总预算', async (t) => {
  const budget = 5000
  const repo = flowRepo(t, { fallback: ['secondary'], timeoutMs: budget })
  const { r, calls, notices, ms } = await flow(repo, { FAKE_SCENARIOS: 'timeout,candidate' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(calls, ['m-primary', 'm-fallback'])
  assert.ok(notices.some((n) => /primary：超时；改用回退后端 secondary/.test(n)))
  assert.ok(ms >= budget * (1 - FALLBACK_RESERVE) - 200, `首选用满了分给它的预算：${ms}`)
  assert.ok(ms < budget + 1000, `总耗时不超过总预算：${Math.round(ms)}ms`)
})

test('hook：回退成功时写入消息，诊断各占一行', (t) => {
  const repo = flowRepo(t, { fallback: ['secondary'] })
  const msgFile = join(repo.dir, '.git', 'COMMIT_EDITMSG')
  writeFileSync(msgFile, '')
  const log = join(repo.sandbox.root, 'fake.jsonl')
  const r = spawnSync(process.execPath, [BUNDLE, 'hook', 'prepare-commit-msg', '--install-id', 't', '--', '.git/COMMIT_EDITMSG', ''], {
    cwd: repo.dir, env: repo.sandbox.env({ FAKE_LOG: log, FAKE_SCENARIOS: 'quota,candidate' }), encoding: 'utf8', timeout: 60_000,
  })
  assert.equal(r.status, 0)
  assert.match(readFileSync(msgFile, 'utf8'), /^fix: 修复示例问题/)
  const lines = r.stderr.split('\n').filter(Boolean)
  assert.ok(lines.every((l) => l.startsWith('ai-commit: ')), r.stderr)
  assert.ok(lines.some((l) => l.includes('改用回退后端 secondary')))
  assert.ok(lines.some((l) => l.includes('由回退后端 secondary 生成')))
  assert.ok(!r.stderr.includes(tmpdir()), '不输出临时目录等内部细节')
})

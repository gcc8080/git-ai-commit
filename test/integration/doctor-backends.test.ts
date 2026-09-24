// 14.2 doctor 的后端部分：版本与兼容性状态、认证状态、同账户额度提示、残留的 opencode 会话；期间不发起模型请求
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Sandbox, type Repo } from '../helpers/repo.ts'
import { BUNDLE } from '../helpers/paths.ts'
import { FAKE, installPrepareHook, writeMachineConfig } from '../helpers/setup.ts'
import { accountFamily, parseOpencodeCredentials } from '../../src/backend/auth.ts'
import type { Profile } from '../../src/config/machine.ts'

function setup(t: { after: (fn: () => void) => void }, machine: Record<string, unknown> = {}) {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const repo = sb.repo()
  installPrepareHook(repo)
  writeMachineConfig(sb, machine)
  return repo
}

/** 在沙箱里建一个名为 harness 的假后端（符号链接），假后端据此模拟对应 CLI。 */
function fakeAs(repo: Repo, harness: string): string {
  const p = join(repo.sandbox.root, harness)
  if (!existsSync(p)) symlinkSync(FAKE, p)
  return p
}

function doctor(repo: Repo, env: Record<string, string> = {}) {
  const log = join(repo.sandbox.root, 'fake.log')
  const probeLog = join(repo.sandbox.root, 'probe.log')
  const r = spawnSync(process.execPath, [BUNDLE, 'doctor'], { cwd: repo.dir, env: repo.sandbox.env({ FAKE_LOG: log, FAKE_PROBE_LOG: probeLog, ...env }), encoding: 'utf8', timeout: 60_000 })
  // 生成调用次数：日志中除 opencode 会话命令（session list / delete）以外的记录
  const invocations = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.trim() !== '' && !l.includes('"scenario":"session"')).length : 0
  return { status: r.status ?? -1, stdout: r.stdout, invocations, probes: existsSync(probeLog) ? readFileSync(probeLog, 'utf8') : '' }
}

test('doctor：列出版本与兼容性状态、认证状态；期间后端的生成调用次数为零', (t) => {
  const repo = setup(t)
  const r = doctor(repo)
  assert.equal(r.status, 0, r.stdout)
  assert.match(r.stdout, /✓ fake：.*fake-harness\.mjs（claude 0\.0\.1） 未验证，照常调用/)
  assert.match(r.stdout, /原因：版本 0\.0\.1 不在合同测试基线内/)
  assert.match(r.stdout, /认证：已登录（claude\.ai）/)
  assert.doesNotMatch(r.stdout, /someone@example\.com|Secret Org/, '不回显认证命令的原始输出')
  assert.equal(r.invocations, 0, '没有发起模型请求')
  assert.match(r.probes, /"probe":"auth"/)
  assert.match(r.probes, /"probe":"help"/)
})

test('doctor：未登录时报告问题', (t) => {
  const repo = setup(t)
  const r = doctor(repo, { FAKE_AUTH: 'missing' })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /✗ fake：未登录，请在 claude 中登录/)
  assert.equal(r.invocations, 0)
})

test('doctor：缺少必需的限制参数时报告不兼容', (t) => {
  const repo = setup(t)
  const r = doctor(repo, { FAKE_HELP_OMIT: '--safe-mode' })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /✗ fake：.* 不兼容，不会被调用：缺少必需的限制参数：--safe-mode/)
  assert.equal(r.invocations, 0)
})

test('doctor：严格模式下未验证的版本报告为问题', (t) => {
  const repo = setup(t, { strict: true })
  const r = doctor(repo)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /为未验证状态，严格模式下不会被调用/)
})

test('doctor：回退链中共用同一账户额度的后端给出提示（codex 与走 openai-codex 的 pi）', (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const repo = sb.repo()
  installPrepareHook(repo)
  writeMachineConfig(sb, {
    defaultProfile: 'cx',
    profiles: {
      cx: { harness: 'codex', model: 'gpt-5.5', executable: fakeAs(repo, 'codex') },
      pio: { harness: 'pi', provider: 'openai-codex', model: 'gpt-5.5', executable: fakeAs(repo, 'pi') },
    },
    fallback: ['pio'],
  })
  const r = doctor(repo)
  assert.match(r.stdout, /! 回退链中的 cx（codex）与 pio（pi）可能共用同一账户（OpenAI）的额度/)
  assert.match(r.stdout, /cx：.*（codex 0\.0\.1）/)
  assert.match(r.stdout, /认证：已登录（ChatGPT）/)
  assert.match(r.stdout, /认证：provider openai-codex 已就绪（oauth）/)
  assert.equal(r.invocations, 0)
})

test('doctor：回退链中是不同账户时不提示', (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const repo = sb.repo()
  writeMachineConfig(sb, {
    defaultProfile: 'cl',
    profiles: {
      cl: { harness: 'claude', model: 'haiku', executable: FAKE },
      pio: { harness: 'pi', provider: 'openai-codex', model: 'gpt-5.5', executable: fakeAs(repo, 'pi') },
    },
    fallback: ['pio'],
  })
  assert.doesNotMatch(doctor(repo).stdout, /共用同一账户/)
})

test('doctor：按标题列出本工具残留的 opencode 会话', (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const repo = sb.repo()
  writeMachineConfig(sb, { defaultProfile: 'oc', profiles: { oc: { harness: 'opencode', model: 'deepseek/deepseek-flash', executable: fakeAs(repo, 'opencode') } } })
  const sessions = [{ id: 'ses_left1', title: 'git-ai-commit' }, { id: 'ses_user', title: '我自己的会话' }, { id: 'ses_left2', title: 'git-ai-commit' }]
  const r = doctor(repo, { FAKE_SESSIONS: JSON.stringify(sessions) })
  assert.match(r.stdout, /! 有 2 个本工具残留的会话（调用被中断时来不及删除）：ses_left1, ses_left2/)
  assert.doesNotMatch(r.stdout, /ses_user/)
  assert.match(r.stdout, /opencode session delete <id>/)
  assert.match(r.stdout, /认证：opencode 中没有 provider deepseek 的已存储凭证/)
  assert.equal(r.invocations, 0)
  const clean = doctor(repo, { FAKE_SESSIONS: '[]' })
  assert.match(clean.stdout, /✓ 没有本工具残留的会话/)
})

test('账户来源与 opencode 凭证解析', () => {
  const p = (o: Partial<Profile>): Profile => ({ name: 'x', harness: 'claude', model: 'm', provider: null, effort: null, executable: null, ...o })
  assert.equal(accountFamily(p({ harness: 'codex' })), 'OpenAI')
  assert.equal(accountFamily(p({ harness: 'pi', provider: 'openai-codex' })), 'OpenAI')
  assert.equal(accountFamily(p({ harness: 'opencode', model: 'openai/gpt-5.5' })), 'OpenAI')
  assert.equal(accountFamily(p({ harness: 'claude' })), 'Anthropic')
  assert.equal(accountFamily(p({ harness: 'pi', provider: 'anthropic' })), 'Anthropic')
  assert.equal(accountFamily(p({ harness: 'opencode', model: 'deepseek/deepseek-flash' })), 'deepseek')
  const out = '\x1b[0m\n┌  Credentials \x1b[90m~/.local/share/opencode/auth.json\n│\n●  OpenAI \x1b[90moauth\n│\n●  DeepSeek \x1b[90mapi\n│\n└  2 credentials\n'
  assert.deepEqual(parseOpencodeCredentials(out), [{ provider: 'OpenAI', type: 'oauth' }, { provider: 'DeepSeek', type: 'api' }])
})

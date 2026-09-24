// codex / pi / opencode adapter 与假后端：参数映射、传输层解析、失败分类、pi 的精确模型核对、opencode 的会话清理
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Sandbox } from '../helpers/repo.ts'
import { FIXTURES } from '../helpers/paths.ts'
import { codexArgs, codexBackend, codexSchema } from '../../src/backend/codex.ts'
import { parseModelList, piArgs, piBackend } from '../../src/backend/pi.ts'
import { OPENCODE_AGENT, OPENCODE_TITLE, opencodeArgs, opencodeBackend } from '../../src/backend/opencode.ts'
import { createBackend } from '../../src/backend/registry.ts'
import type { Backend, InvokeResult } from '../../src/backend/types.ts'
import type { Harness, Profile } from '../../src/config/machine.ts'

const FAKE = join(FIXTURES, 'fake-harness.mjs')
const DEFAULT_MODEL: Record<Harness, [string, string | null]> = {
  claude: ['haiku', null],
  codex: ['gpt-5.4-mini', null],
  pi: ['gpt-5.5', 'openai-codex'],
  opencode: ['deepseek/deepseek-flash', null],
}
const profile = (harness: Harness, over: Partial<Profile> = {}): Profile => ({
  name: harness, harness, model: DEFAULT_MODEL[harness][0], provider: DEFAULT_MODEL[harness][1], effort: null, executable: FAKE, ...over,
})
const req = (prompt = 'P', ms = 10_000) => ({ prompt, deadline: performance.now() + ms, signal: new AbortController().signal })
const failureClass = (r: InvokeResult) => (r.ok ? null : r.failure.class)

interface LogRecord { scenario: string; argv: string[]; env: Record<string, string>; schema?: unknown }
function readLog(file: string): LogRecord[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogRecord)
}

async function run(harness: Harness, scenario: string, over: Partial<Profile> = {}, extraEnv: Record<string, string> = {}, prompt = 'P', ms = 10_000) {
  const sb = new Sandbox()
  const log = join(sb.root, 'fake.jsonl')
  const backend: Backend = createBackend(profile(harness, over), sb.env({ FAKE_HARNESS: harness, FAKE_SCENARIO: scenario, FAKE_LOG: log, ...extraEnv }))
  try {
    const r = await backend.invoke(req(prompt, ms))
    return { r, log: readLog(log) }
  } finally {
    sb.cleanup()
  }
}

test('registry：四个 harness 各自构造对应的后端', () => {
  for (const h of ['claude', 'codex', 'pi', 'opencode'] as const) assert.equal(createBackend(profile(h)).harness, h)
})

// ---------- codex ----------

test('codex 参数：不加载用户配置、只读 sandbox、关闭 shell/hooks/插件/联网搜索/审批，prompt 走 stdin，结果写文件', () => {
  const args = codexArgs(profile('codex', { effort: 'low', provider: 'openai' }))
  assert.deepEqual(args.slice(0, 9), ['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--color', 'never', '-s', 'read-only'])
  for (const c of ['features.shell_tool=false', 'features.hooks=false', 'features.plugins=false', 'features.image_generation=false', 'features.goals=false', 'web_search="disabled"', 'approval_policy="never"', 'model_reasoning_effort="low"', 'model_provider="openai"']) {
    assert.equal(args[args.indexOf(c) - 1], '-c', c)
  }
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-5.4-mini')
  assert.equal(args[args.indexOf('--output-schema') + 1], '{tmp}/schema.json')
  assert.equal(args[args.indexOf('-o') + 1], '{tmp}/last-message.txt')
  assert.equal(args.at(-1), '-')
})

test('codex schema：严格模式要求全部字段必填、禁止额外字段', () => {
  const s = codexSchema() as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean }
  assert.equal(s.additionalProperties, false)
  assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort())
})

test('codex 成功：从 -o 文件取结果，传入的是严格 schema，工作目录是 0700 临时目录', async () => {
  const { r, log } = await run('codex', 'candidate')
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.output.kind, 'text')
  assert.equal(log.length, 1)
  assert.deepEqual(log[0]!.schema, codexSchema())
})

for (const [scenario, cls] of [['quota', 'quota'], ['auth', 'auth'], ['nonzero', 'unknown'], ['truncate', 'unknown'], ['empty', 'unknown']] as const) {
  test(`codex 失败场景 ${scenario} → ${cls}`, async () => {
    const { r } = await run('codex', scenario)
    assert.equal(failureClass(r), cls)
  })
}

test('codex：stderr 回显的 prompt 不参与分类，终端只见一行固定原因', async () => {
  const prompt = 'diff 中提到 rate limit、quota、401 unauthorized'
  const { r } = await run('codex', 'echo-stderr', {}, {}, prompt)
  assert.equal(failureClass(r), 'unknown')
  if (!r.ok) {
    assert.ok(!r.failure.message.includes('diff'), r.failure.message)
    assert.ok(!r.failure.message.includes('\n'))
  }
})

test('codex：额度耗尽时即使 stderr 回显了 prompt，也按 ERROR 行分类', async () => {
  const { r } = await run('codex', 'quota', {}, {}, 'Not logged in\n401 unauthorized\n')
  assert.equal(failureClass(r), 'quota')
})

test('codex：effort 含有不允许的字符时报配置错误，不调用后端', async () => {
  const { r, log } = await run('codex', 'candidate', { effort: 'low" sandbox_mode="danger-full-access' })
  assert.equal(failureClass(r), 'config')
  assert.equal(log.length, 0)
})

// ---------- pi ----------

test('pi 参数：关闭工具、扩展、skills、模板、上下文文件与 session，显式 provider 与模型', () => {
  const args = piArgs(profile('pi', { effort: 'low' }))
  for (const f of ['-p', '-nt', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-session', '--no-approve']) assert.ok(args.includes(f), f)
  assert.equal(args[args.indexOf('--provider') + 1], 'openai-codex')
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.5')
  assert.equal(args[args.indexOf('--thinking') + 1], 'low')
  assert.equal(args[args.indexOf('--mode') + 1], 'text')
})

test('pi 模型列表解析', () => {
  const out = 'provider      model    context  max-out  thinking  images\nopenai-codex  gpt-5.5  272K     128K     yes       yes\n\nopenai-codex  gpt-5.5-mini  272K  128K  yes  yes\n'
  assert.deepEqual(parseModelList(out), [{ provider: 'openai-codex', model: 'gpt-5.5' }, { provider: 'openai-codex', model: 'gpt-5.5-mini' }])
})

test('pi 成功：模型精确匹配后调用，stdout 即结果', async () => {
  const { r, log } = await run('pi', 'candidate', {}, { FAKE_PI_MODELS: 'openai-codex/gpt-5.5,openai-codex/gpt-5.5-mini' })
  assert.equal(r.ok, true)
  assert.equal(log.length, 1)
})

for (const [model, why] of [['gpt-5', '模糊前缀'], ['gpt-5.5:high', '带 thinking 后缀'], ['openai-codex/gpt-5.5', '带 provider 前缀']] as const) {
  test(`pi：模型标识不明确（${why}）时报配置错误，不做模糊匹配也不调用`, async () => {
    const { r, log } = await run('pi', 'candidate', { model }, { FAKE_PI_MODELS: 'openai-codex/gpt-5.5,openai-codex/gpt-5.5-mini' })
    assert.equal(failureClass(r), 'config')
    if (!r.ok) assert.match(r.failure.message, /精确匹配/)
    assert.equal(log.length, 0)
  })
}

test('pi：同名模型属于别的 provider 时不算匹配', async () => {
  const { r } = await run('pi', 'candidate', {}, { FAKE_PI_MODELS: 'openai/gpt-5.5' })
  assert.equal(failureClass(r), 'config')
})

for (const [scenario, cls] of [['quota', 'quota'], ['auth', 'auth'], ['nonzero', 'unknown'], ['empty', 'unknown']] as const) {
  test(`pi 失败场景 ${scenario} → ${cls}`, async () => {
    const { r } = await run('pi', scenario)
    assert.equal(failureClass(r), cls)
  })
}

// ---------- opencode ----------

test('opencode 参数：纯净模式、JSON 事件流、专用 agent、本工具的会话标题', () => {
  const args = opencodeArgs(profile('opencode', { effort: 'high' }))
  assert.equal(args[0], 'run')
  assert.ok(args.includes('--pure'))
  assert.equal(args[args.indexOf('--format') + 1], 'json')
  assert.equal(args[args.indexOf('--title') + 1], OPENCODE_TITLE)
  assert.equal(args[args.indexOf('--agent') + 1], OPENCODE_AGENT)
  assert.equal(args[args.indexOf('-m') + 1], 'deepseek/deepseek-flash')
  assert.equal(args[args.indexOf('--variant') + 1], 'high')
})

test('opencode 成功：注入 agent 配置（两级 permission 均为 deny），结束后删除本次会话', async () => {
  const { r, log } = await run('opencode', 'candidate')
  assert.equal(r.ok, true)
  const gen = log.filter((l) => l.scenario !== 'session')
  assert.equal(gen.length, 1)
  const config = JSON.parse(gen[0]!.env.OPENCODE_CONFIG_CONTENT!) as { permission: string; agent: Record<string, { permission: string; mode: string }> }
  assert.equal(config.permission, 'deny')
  assert.equal(config.agent[OPENCODE_AGENT]!.permission, 'deny')
  assert.equal(config.agent[OPENCODE_AGENT]!.mode, 'primary')
  const deletes = log.filter((l) => l.scenario === 'session')
  assert.deepEqual(deletes.map((l) => l.argv), [['session', 'delete', 'ses_fake']])
  assert.equal(deletes[0]!.env.OPENCODE_CONFIG_CONTENT, undefined)
})

for (const [scenario, cls] of [['quota', 'quota'], ['auth', 'auth'], ['unavailable', 'unavailable']] as const) {
  test(`opencode 错误事件 ${scenario} → ${cls}（只看 name/message/statusCode，不看响应头），会话同样被删除`, async () => {
    const { r, log } = await run('opencode', scenario)
    assert.equal(failureClass(r), cls)
    assert.deepEqual(log.filter((l) => l.scenario === 'session').map((l) => l.argv), [['session', 'delete', 'ses_fake']])
  })
}

for (const [scenario, cls] of [['truncate', 'unknown'], ['nonzero', 'unknown'], ['empty', 'unknown']] as const) {
  test(`opencode 失败场景 ${scenario} → ${cls}`, async () => {
    const { r } = await run('opencode', scenario)
    assert.equal(failureClass(r), cls)
  })
}

test('opencode 超时：终止进程组并报超时', async () => {
  const started = performance.now()
  const { r } = await run('opencode', 'timeout', {}, {}, 'P', 1500)
  assert.equal(failureClass(r), 'timeout')
  assert.ok(performance.now() - started < 8000)
})

test('opencode：用户配置中的 MCP 服务器在注入的配置里逐个设为 enabled: false', async () => {
  const { r, log } = await run('opencode', 'candidate', {}, { FAKE_OPENCODE_MCP: 'figma,node_repl' })
  assert.equal(r.ok, true)
  const gen = log.filter((l) => l.scenario !== 'session')
  const config = JSON.parse(gen[0]!.env.OPENCODE_CONFIG_CONTENT!) as { mcp?: Record<string, { enabled: boolean }> }
  assert.deepEqual(config.mcp, { figma: { enabled: false }, node_repl: { enabled: false } })
})

test('opencode：没有 MCP 服务器时不注入 mcp 字段', async () => {
  const { log } = await run('opencode', 'candidate')
  const config = JSON.parse(log.filter((l) => l.scenario !== 'session')[0]!.env.OPENCODE_CONFIG_CONTENT!) as Record<string, unknown>
  assert.equal('mcp' in config, false)
})

test('opencode：MCP 名称按配置文件身份缓存，配置变化后重新解析；解析失败时照常调用', async (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const probeLog = join(sb.root, 'probe.jsonl')
  const cfgDir = join(sb.home, '.config', 'opencode')
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(join(cfgDir, 'opencode.json'), '{}')
  const env = sb.env({ FAKE_HARNESS: 'opencode', FAKE_PROBE_LOG: probeLog, FAKE_OPENCODE_MCP: 'a' })
  const b = createBackend(profile('opencode'), env)
  const count = () => readLog(probeLog).filter((l) => (l as unknown as { probe?: string }).probe === 'debug-config').length
  assert.equal((await b.invoke(req())).ok, true)
  assert.equal((await b.invoke(req())).ok, true)
  assert.equal(count(), 1, '第二次命中缓存')
  writeFileSync(join(cfgDir, 'opencode.json'), '{"mcp":{}}')
  assert.equal((await b.invoke(req())).ok, true)
  assert.equal(count(), 2, '配置文件变化后重新解析')
  const failing = createBackend(profile('opencode'), sb.env({ FAKE_HARNESS: 'opencode', FAKE_OPENCODE_DEBUG_FAIL: '1', XDG_CACHE_HOME: join(sb.root, 'other-cache') }))
  assert.equal((await failing.invoke(req())).ok, true, '解析失败不阻止生成')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRepoConfig, looksLikeCredentialKey } from '../../src/config/repo.ts'
import { effectiveRules, DEFAULT_EXCLUDE, DEFAULT_RULES } from '../../src/config/rules.ts'
import { emptyMachineConfig, parseMachineConfig } from '../../src/config/machine.ts'
import { resolveProfileName } from '../../src/config/profile.ts'

// ---------- 2.1 仓库共享配置 ----------

test('合法的提交规范字段被接受', () => {
  const { value, diagnostics } = parseRepoConfig(JSON.stringify({
    language: 'en', format: 'conventional', headerMaxWidth: 60, headerMaxLength: 70, lengthUnit: 'utf16',
    types: ['feat', 'fix'], scopeRules: { 'apps/android/**': 'android' },
    maxInputBytes: 5000, maxPerFileBytes: 1000, exclude: ['*.secret'], statOnly: ['*.snap'],
  }))
  assert.deepEqual(diagnostics, [])
  const rules = effectiveRules(value)
  assert.equal(rules.language, 'en')
  assert.equal(rules.headerMaxWidth, 60)
  assert.equal(rules.lengthUnit, 'utf16')
  assert.deepEqual(rules.types, ['feat', 'fix'])
  assert.ok(rules.exclude.includes('*.secret'), '仓库可追加排除项')
  assert.ok(DEFAULT_EXCLUDE.every((p) => rules.exclude.includes(p)), '默认排除项不能被移除')
})

const rejected: Array<[string, unknown, RegExp]> = [
  ['凭证：顶层键', { apiKey: 'sk-123' }, /不能携带凭证/],
  ['凭证：嵌套键', { provider_settings: { authToken: 'x' } }, /不能携带凭证/],
  ['凭证：token 字段', { token: 'abc' }, /不能携带凭证/],
  ['可执行命令', { command: 'rm -rf /' }, /不能定义可执行命令/],
  ['可执行命令：hooks', { hooks: { pre: 'x' } }, /不能定义可执行命令/],
  ['回退链', { fallbackProfiles: ['a'] }, /回退链只能在本机配置中定义/],
  ['预热开关', { prewarm: true }, /预热开关只能由用户在本机开启/],
  ['后端选择', { harness: 'claude' }, /属于本机配置/],
]

for (const [name, obj, pattern] of rejected) {
  test(`拒绝字段：${name}`, () => {
    const { value, diagnostics } = parseRepoConfig(JSON.stringify(obj))
    assert.equal(Object.keys(value).length, 0, '被拒字段不进入规则')
    assert.match(diagnostics.join('\n'), pattern)
  })
}

test('凭证嵌套在合法字段中时，整个字段被拒绝', () => {
  const { value, diagnostics } = parseRepoConfig(JSON.stringify({ scopeRules: { 'a/**': 'a', password: 'x' } }))
  assert.equal(value.scopeRules, undefined)
  assert.match(diagnostics.join('\n'), /不能携带凭证/)
})

test('键名是否像凭证：避免误伤 author 之类的词', () => {
  assert.equal(looksLikeCredentialKey('author'), false)
  assert.equal(looksLikeCredentialKey('apiKey'), true)
  assert.equal(looksLikeCredentialKey('api_key'), true)
  assert.equal(looksLikeCredentialKey('authToken'), true)
  assert.equal(looksLikeCredentialKey('client-secret'), true)
})

test('未知字段与无效值：忽略并给出诊断，其余字段照常生效', () => {
  const { value, diagnostics } = parseRepoConfig(JSON.stringify({ colour: 'red', headerMaxWidth: -1, language: 'ja' }))
  assert.deepEqual(value, { language: 'ja' })
  assert.match(diagnostics.join('\n'), /未知字段 "colour"/)
  assert.match(diagnostics.join('\n'), /"headerMaxWidth" 的值无效/)
})

test('不是合法 JSON 时回到默认规则', () => {
  const { value, diagnostics } = parseRepoConfig('{ not json')
  assert.deepEqual(value, {})
  assert.match(diagnostics[0]!, /不是合法的 JSON/)
  assert.deepEqual(effectiveRules(value).types, DEFAULT_RULES.types)
})

// ---------- 2.2 本机配置 ----------

test('四个维度各自独立：effort 不拼进模型标识', () => {
  const { value, diagnostics } = parseMachineConfig(JSON.stringify({
    defaultProfile: 'c',
    profiles: {
      c: { harness: 'claude', model: 'haiku', effort: 'low' },
      p: { harness: 'pi', provider: 'openai-codex', model: 'gpt-5.1-codex-mini', effort: 'minimal' },
    },
    fallback: ['p'],
    strict: true,
    timeoutMs: 30000,
  }))
  assert.deepEqual(diagnostics, [])
  const c = value.profiles.get('c')!
  assert.equal(c.model, 'haiku')
  assert.equal(c.effort, 'low')
  assert.ok(!c.model.includes('low'))
  assert.equal(value.profiles.get('p')!.provider, 'openai-codex')
  assert.deepEqual(value.fallback, ['p'])
  assert.equal(value.strict, true)
  assert.equal(value.timeoutMs, 30000)
})

const badProfiles: Array<[string, unknown, RegExp]> = [
  ['缺少 harness', { model: 'x' }, /缺少必填字段 harness/],
  ['不支持的 harness', { harness: 'gemini', model: 'x' }, /不受支持/],
  ['缺少 model', { harness: 'claude' }, /缺少必填字段 model/],
  ['pi 缺少 provider', { harness: 'pi', model: 'm' }, /pi 必须显式指定 provider/],
  ['claude 带 provider', { harness: 'claude', model: 'haiku', provider: 'anthropic' }, /claude 不使用 provider/],
  ['opencode 的 model 不是 provider/model', { harness: 'opencode', model: 'haiku' }, /provider\/model 形式/],
  ['executable 不是绝对路径', { harness: 'claude', model: 'haiku', executable: 'bin/claude' }, /必须是绝对路径/],
]

for (const [name, prof, pattern] of badProfiles) {
  test(`本机配置报错：${name}`, () => {
    const { value, diagnostics } = parseMachineConfig(JSON.stringify({ profiles: { x: prof } }))
    assert.equal(value.profiles.has('x'), false)
    assert.match(diagnostics.join('\n'), pattern)
  })
}

test('defaultProfile 与 fallback 必须引用存在的 profile', () => {
  const { value, diagnostics } = parseMachineConfig(JSON.stringify({
    profiles: { a: { harness: 'claude', model: 'haiku' } }, defaultProfile: 'zzz', fallback: ['a', 'nope'],
  }))
  assert.equal(value.defaultProfile, null)
  assert.deepEqual(value.fallback, ['a'])
  assert.match(diagnostics.join('\n'), /defaultProfile "zzz" 不存在/)
  assert.match(diagnostics.join('\n'), /"nope" 不存在/)
})

// ---------- 2.3 选择优先级（纯函数部分）----------

test('优先级：--profile → 环境变量 → git 本地配置 → 本机默认', () => {
  const all = { flag: 'a', env: 'b', gitLocal: 'c', machineDefault: 'd' }
  assert.deepEqual(resolveProfileName(all), { name: 'a', source: 'flag' })
  assert.deepEqual(resolveProfileName({ ...all, flag: undefined }), { name: 'b', source: 'env' })
  assert.deepEqual(resolveProfileName({ ...all, flag: undefined, env: '' }), { name: 'c', source: 'git' })
  assert.deepEqual(resolveProfileName({ machineDefault: 'd' }), { name: 'd', source: 'default' })
  assert.equal(resolveProfileName({}), null)
})

test('前台总预算默认 45s，回退链默认为空、严格模式默认关闭', () => {
  const d = emptyMachineConfig()
  assert.equal(d.timeoutMs, 45_000)
  assert.deepEqual(d.fallback, [])
  assert.equal(d.strict, false)
})

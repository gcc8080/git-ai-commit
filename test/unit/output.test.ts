import { test } from 'node:test'
import assert from 'node:assert/strict'
import { displayWidth } from '../../src/util/eaw.ts'
import { issueRefs, validateOutput, type Candidate } from '../../src/output/schema.ts'
import { parseJsonText } from '../../src/output/parse.ts'
import { renderMessage } from '../../src/output/render.ts'
import { effectiveRules } from '../../src/config/rules.ts'
import { generateWith } from '../../src/generate.ts'
import type { Backend, InvokeRequest, InvokeResult } from '../../src/backend/types.ts'
import type { ModelInput } from '../../src/input/build.ts'

const rules = effectiveRules({})
const ctx = { rules, inputText: 'diff mentions #12 and PROJ-7' }
const ok = { type: 'fix', scope: 'cache', subject: '修复缓存过期判断', body: ['读取时清理过期条目'], breakingChange: null }

// ---------- 6.1 schema 与校验 ----------

test('合法候选与拒绝结果', () => {
  assert.deepEqual(validateOutput(ok, ctx), { ok: true, value: { kind: 'candidate', candidate: ok } })
  assert.deepEqual(validateOutput({ refusal: '差异只有格式调整' }, ctx), { ok: true, value: { kind: 'refusal', reason: '差异只有格式调整' } })
  // codex 的严格 schema 会把所有字段都带上，值为 null
  assert.equal(validateOutput({ type: null, scope: null, subject: null, body: [], breakingChange: null, refusal: '不足' }, ctx).ok, true)
  assert.equal(validateOutput({ ...ok, refusal: null }, ctx).ok, true)
  assert.equal(validateOutput({ ...ok, scope: '' }, ctx).ok, true, '空字符串 scope 视为无 scope')
})

const invalid: Array<[string, unknown, RegExp]> = [
  ['不是对象', '["x"]', /必须是一个 JSON 对象/],
  ['额外字段', { ...ok, reason: 'x' }, /额外字段：reason/],
  ['type 不在枚举中', { ...ok, type: 'update' }, /type 必须是以下之一/],
  ['scope 含空格', { ...ok, scope: 'my scope' }, /scope 必须/],
  ['subject 多行', { ...ok, subject: '第一行\n第二行' }, /subject 必须是非空的单行字符串/],
  ['subject 含控制字符', { ...ok, subject: 'a\u0007b' }, /subject 必须/],
  ['body 不是数组', { ...ok, body: 'x' }, /body 必须是字符串数组/],
  ['body 条数超限', { ...ok, body: Array.from({ length: 9 }, (_, i) => `第 ${i} 条`) }, /body 最多 8 条/],
  ['body 单条超长', { ...ok, body: ['字'.repeat(201)] }, /超过 200 个字符/],
  ['伪造 Signed-off-by', { ...ok, body: ['Signed-off-by: Bot <bot@x>'] }, /尾注格式/],
  ['伪造 Co-Authored-By', { ...ok, body: ['Co-Authored-By: Claude <noreply@anthropic.com>'] }, /尾注格式/],
  ['伪造 Change-Id', { ...ok, body: ['Change-Id: I123'] }, /尾注格式/],
  ['自己写 BREAKING CHANGE', { ...ok, body: ['BREAKING CHANGE: 接口变了'] }, /尾注格式/],
  ['编造 issue 编号 #', { ...ok, body: ['修复 #999 报告的问题'] }, /不存在的 issue 编号：#999/],
  ['编造 JIRA 编号', { ...ok, subject: '完成 ABC-45 的需求' }, /不存在的 issue 编号：ABC-45/],
  ['拒绝与候选混用', { ...ok, refusal: '不足' }, /不能同时包含候选字段/],
]
for (const [name, value, pattern] of invalid) {
  test(`不合规：${name}`, () => {
    const v = validateOutput(typeof value === 'string' ? JSON.parse(value) : value, ctx)
    assert.equal(v.ok, false)
    assert.match((v as { errors: string[] }).errors.join('\n'), pattern)
  })
}

test('输入中出现过的 issue 编号允许引用；UTF-8、SHA-256 等不算 issue 编号', () => {
  assert.equal(validateOutput({ ...ok, body: ['对应 #12 与 PROJ-7'] }, ctx).ok, true)
  assert.deepEqual(issueRefs('改用 UTF-8 编码并校验 SHA-256 与 ISO-8601 日期，符合 RFC-3339'), [])
  assert.deepEqual(issueRefs('see #3, a&#12; entity, http://x/#4'), ['#3'])
})

// ---------- 6.2 兜底解析 ----------

test('兜底解析：只剥最外层代码围栏，其余情况一律失败', () => {
  assert.deepEqual(parseJsonText('```json\n{"a":1}\n```'), { ok: true, value: { a: 1 } })
  assert.deepEqual(parseJsonText('  {"a":1}  '), { ok: true, value: { a: 1 } })
  assert.equal(parseJsonText('{"type":"fix","subj').ok, false, '截断')
  assert.equal(parseJsonText('好的，结果如下：{"a":1}').ok, false, '前面夹带说明文字')
  assert.equal(parseJsonText('{"a":1}\n以上是结果').ok, false, '后面夹带说明文字')
  assert.equal(parseJsonText('```json\n{"a":1}').ok, false, '围栏不完整')
  assert.equal(parseJsonText('').ok, false)
})

// ---------- 6.3 header 长度 ----------

test('显示宽度：CJK、emoji 计 2 列，组合字符与零宽字符计 0 列', () => {
  assert.equal(displayWidth('abc'), 3)
  assert.equal(displayWidth('中文'), 4)
  assert.equal(displayWidth('Ａ'), 2)
  assert.equal(displayWidth('ｱ'), 1)
  assert.equal(displayWidth('😀'), 2)
  assert.equal(displayWidth('👨‍👩‍👧'), 2)
  assert.equal(displayWidth('🇨🇳'), 2)
  assert.equal(displayWidth('é'), 1)
  assert.equal(displayWidth('a\u0000b'), 2)
})

test('中文字符数未超限，但显示宽度超限：判为超长', () => {
  const subject = '修'.repeat(40) // header = "fix: " + 40 个汉字：码点 45，显示宽度 85
  const v = validateOutput({ ...ok, scope: null, subject }, ctx)
  assert.equal(v.ok, false)
  const errs = (v as { errors: string[] }).errors.join('\n')
  assert.match(errs, /显示宽度 85 列，上限 72 列/)
  assert.doesNotMatch(errs, /长度 45/)
})

test('完整 header 计入 type、scope 与破坏性标记；仓库可覆盖上限与计数单位', () => {
  const r = effectiveRules({ headerMaxWidth: 20, headerMaxLength: 12, lengthUnit: 'utf16' })
  const v = validateOutput({ type: 'feat', scope: 'api', subject: 'ab😀', body: [], breakingChange: '接口变更' }, { rules: r, inputText: '' })
  // "feat(api)!: ab😀"：显示宽度 16 ≤ 20；UTF-16 码元 16 > 12
  assert.equal(v.ok, false)
  assert.match((v as { errors: string[] }).errors.join('\n'), /长度 16，上限 12/)
})

function fakeBackend(outputs: unknown[]): Backend & { calls: InvokeRequest[] } {
  const calls: InvokeRequest[] = []
  return {
    name: 'fake', harness: 'claude', calls,
    async invoke(req): Promise<InvokeResult> {
      calls.push(req)
      const o = outputs[Math.min(calls.length - 1, outputs.length - 1)]
      return { ok: true, output: typeof o === 'string' ? { kind: 'text', text: o } : { kind: 'json', value: o } }
    },
  }
}
const input: ModelInput = { prompt: 'PROMPT', data: 'DATA', files: [], history: [] }
const opts = () => ({ rules, deadline: performance.now() + 5000, signal: new AbortController().signal })

test('超长时至多纠正一次：纠正成功则采用', async () => {
  const b = fakeBackend([{ ...ok, subject: '修'.repeat(40) }, ok])
  const r = await generateWith(b, input, opts())
  assert.equal(r.ok, true)
  assert.equal(b.calls.length, 2)
  assert.match(b.calls[1]!.prompt, /显示宽度 92 列/)
  assert.equal(b.calls[0]!.deadline, b.calls[1]!.deadline, '纠正不重置截止时间')
})

test('纠正后仍超长：判为失败，不裁剪原文', async () => {
  const long = { ...ok, subject: '修'.repeat(40) }
  const b = fakeBackend([long, long])
  const r = await generateWith(b, input, opts())
  assert.equal(r.ok, false)
  assert.equal(b.calls.length, 2)
  assert.equal((r as { failure: { class: string } }).failure.class, 'invalid-output')
  assert.equal('message' in r, false, '没有产出被裁剪的消息')
})

test('非 JSON 文本走一次纠正；模型拒绝不纠正', async () => {
  const b1 = fakeBackend(['好的，这是提交信息', ok])
  assert.equal((await generateWith(b1, input, opts())).ok, true)
  const b2 = fakeBackend([{ refusal: '不足' }])
  const r2 = await generateWith(b2, input, opts())
  assert.equal(r2.ok, false)
  assert.equal(b2.calls.length, 1)
  assert.equal((r2 as { failure: { class: string } }).failure.class, 'refusal')
})

// ---------- 6.4 renderer ----------

const renderCases: Array<[string, Candidate, string]> = [
  ['无 scope、无正文', { type: 'fix', scope: null, subject: '修复 A', body: [], breakingChange: null }, 'fix: 修复 A'],
  ['有 scope、有正文', { type: 'feat', scope: 'api', subject: '新增 B', body: ['第一条', '第二条'], breakingChange: null }, 'feat(api): 新增 B\n\n- 第一条\n- 第二条'],
  ['破坏性变更、无正文', { type: 'refactor', scope: null, subject: '移除 C', body: [], breakingChange: '删除了旧接口' }, 'refactor!: 移除 C\n\nBREAKING CHANGE: 删除了旧接口'],
  ['破坏性变更、有 scope 与正文', { type: 'feat', scope: 'cli', subject: '改名 D', body: ['x'], breakingChange: '参数改名' }, 'feat(cli)!: 改名 D\n\n- x\n\nBREAKING CHANGE: 参数改名'],
]
for (const [name, c, expected] of renderCases) {
  test(`渲染：${name}`, () => assert.equal(renderMessage(c), expected))
}

test('语言：配置为中文时 subject、body 与 breakingChange 都必须含汉字；代码标识符可以夹在中文里', () => {
  const ctx = { rules: effectiveRules({}), inputText: '' }
  const base = { type: 'feat', scope: null, body: [], breakingChange: null }
  assert.equal(validateOutput({ ...base, subject: '新增 clamp() 函数' }, ctx).ok, true)
  const en = validateOutput({ ...base, subject: 'add clamp function' }, ctx)
  assert.equal(en.ok, false)
  if (!en.ok) assert.deepEqual(en.errors, ['subject 必须使用简体中文书写'])
  const body = validateOutput({ ...base, subject: '新增 clamp', body: ['限制数值范围', 'clamp(n, lo, hi)'] }, ctx)
  assert.equal(body.ok, false)
  if (!body.ok) assert.deepEqual(body.errors, ['body[1] 必须使用简体中文书写'])
  const bc = validateOutput({ ...base, subject: '移除旧接口', breakingChange: 'removed v1 API' }, ctx)
  assert.equal(bc.ok, false)
})

test('语言：英文等无法与代码标识符区分的语言不做文字系统检查；日文接受假名或汉字', () => {
  const base = { type: 'feat', scope: null, body: [], breakingChange: null }
  assert.equal(validateOutput({ ...base, subject: 'add clamp function' }, { rules: effectiveRules({ language: 'en' }), inputText: '' }).ok, true)
  const ja = { rules: effectiveRules({ language: 'ja' }), inputText: '' }
  assert.equal(validateOutput({ ...base, subject: 'キャッシュを追加' }, ja).ok, true)
  assert.equal(validateOutput({ ...base, subject: 'add cache' }, ja).ok, false)
})

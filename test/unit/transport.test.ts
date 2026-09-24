// 7.2 传输解析：每种传输都有正常、截断、失败的样例
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEnvelope, parseFileOutput, parseJsonl, parseTextOutput } from '../../src/backend/transport.ts'
import { classifyText } from '../../src/backend/classify.ts'

const env = (o: Record<string, unknown>) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, ...o })
const cls = (r: unknown) => (r as { failure: { class: string } }).failure.class

test('envelope：structured_output 优先；否则取 result 文本', () => {
  assert.deepEqual(parseEnvelope('p', env({ result: '{"a":1}', structured_output: { a: 1 } })), { ok: true, output: { kind: 'json', value: { a: 1 } } })
  assert.deepEqual(parseEnvelope('p', env({ result: '{"a":1}' })), { ok: true, output: { kind: 'text', text: '{"a":1}' } })
})

test('envelope：截断、缺少 result、空结果都判为失败', () => {
  assert.equal(parseEnvelope('p', '{"type":"result","subtype":"succ').ok, false)
  assert.equal(parseEnvelope('p', '').ok, false)
  assert.equal(parseEnvelope('p', '{"type":"assistant"}').ok, false)
  assert.equal(parseEnvelope('p', env({ result: '' })).ok, false)
})

test('envelope：错误按 api_error_status 与文案分类', () => {
  assert.equal(cls(parseEnvelope('p', env({ is_error: true, subtype: 'error_during_execution', api_error_status: 429, result: "You've hit your usage limit" }))), 'quota')
  assert.equal(cls(parseEnvelope('p', env({ is_error: true, api_error_status: 429, result: 'Too many requests' }))), 'rate-limit')
  assert.equal(cls(parseEnvelope('p', env({ is_error: true, api_error_status: 401, result: 'x' }))), 'auth')
  assert.equal(cls(parseEnvelope('p', env({ is_error: true, api_error_status: 529, result: 'Overloaded' }))), 'unavailable')
  assert.equal(cls(parseEnvelope('p', env({ subtype: 'error_max_turns', result: 'x' }))), 'unknown')
})

test('文件输出：正常、缺失、空', () => {
  assert.deepEqual(parseFileOutput('p', '{"a":1}'), { ok: true, output: { kind: 'text', text: '{"a":1}' } })
  assert.equal(parseFileOutput('p', null).ok, false)
  assert.equal(parseFileOutput('p', '  \n').ok, false)
})

test('文本输出：正常与空', () => {
  assert.equal(parseTextOutput('p', '{"a":1}\n').ok, true)
  assert.equal(parseTextOutput('p', '').ok, false)
})

const ev = (o: Record<string, unknown>) => JSON.stringify(o)
test('JSONL：取最后一条 text 事件；需要 step_finish(stop)', () => {
  const ok = [ev({ type: 'step_start', sessionID: 's1', part: {} }), ev({ type: 'text', part: { type: 'text', text: 'draft' } }), ev({ type: 'text', part: { type: 'text', text: '{"a":1}' } }), ev({ type: 'step_finish', part: { reason: 'stop' } })].join('\n')
  const r = parseJsonl('p', ok)
  assert.equal(r.ok, true)
  assert.deepEqual((r as { output: unknown }).output, { kind: 'text', text: '{"a":1}' })
  assert.equal(r.sessionId, 's1')
})

test('JSONL：截断、缺少完成标记、错误事件、空结果都判为失败', () => {
  assert.equal(parseJsonl('p', ev({ type: 'text', part: { text: 'x' } }) + '\n{"type":"te').ok, false)
  assert.equal(parseJsonl('p', ev({ type: 'text', part: { text: 'x' } })).ok, false)
  assert.equal(cls(parseJsonl('p', ev({ type: 'error', error: { message: 'usage limit reached' } }))), 'quota')
  assert.equal(parseJsonl('p', ev({ type: 'step_finish', part: { reason: 'stop' } })).ok, false)
})

test('文案分类', () => {
  assert.equal(classifyText("ERROR: You've hit your usage limit."), 'quota')
  assert.equal(classifyText('Not logged in. Please run /login'), 'auth')
  assert.equal(classifyText("error: unexpected argument '--safe-mode' found"), 'incompatible')
  assert.equal(classifyText('model gpt-x not found'), 'config')
  assert.equal(classifyText('getaddrinfo ENOTFOUND api.anthropic.com'), 'network')
  assert.equal(classifyText('503 Service Unavailable'), 'unavailable')
  assert.equal(classifyText('something odd'), 'unknown')
})

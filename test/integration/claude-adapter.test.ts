// claude adapter 与假后端：非零退出、错误 envelope、截断
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Sandbox } from '../helpers/repo.ts'
import { FIXTURES } from '../helpers/paths.ts'
import { claudeBackend, claudeArgs } from '../../src/backend/claude.ts'
import type { Profile } from '../../src/config/machine.ts'

const profile = (over: Partial<Profile> = {}): Profile => ({ name: 'c', harness: 'claude', model: 'haiku', provider: null, effort: null, executable: join(FIXTURES, 'fake-harness.mjs'), ...over })
const req = () => ({ prompt: 'P', deadline: performance.now() + 10_000, signal: new AbortController().signal })

test('参数：限制参数齐全，effort 用单独的参数传递', () => {
  const args = claudeArgs(profile({ effort: 'low' }))
  for (const f of ['-p', '--safe-mode', '--strict-mcp-config', '--no-session-persistence']) assert.ok(args.includes(f), f)
  assert.equal(args[args.indexOf('--tools') + 1], '', '--tools 的值为空字符串')
  assert.equal(args[args.indexOf('--output-format') + 1], 'json')
  assert.equal(args[args.indexOf('--model') + 1], 'haiku')
  assert.equal(args[args.indexOf('--effort') + 1], 'low')
})

const scenarios: Array<[string, boolean, string | null]> = [
  ['candidate', true, null],
  ['nonzero', false, 'unknown'],
  ['quota', false, 'quota'],
  ['auth', false, 'auth'],
  ['truncate', false, 'unknown'],
  ['empty', false, 'unknown'],
]
for (const [scenario, ok, cls] of scenarios) {
  test(`假后端场景 ${scenario}`, async (t) => {
    const sb = new Sandbox()
    t.after(() => sb.cleanup())
    const log = join(sb.root, 'fake.jsonl')
    const b = claudeBackend(profile(), sb.env({ FAKE_SCENARIO: scenario, FAKE_LOG: log }))
    const r = await b.invoke(req())
    assert.equal(r.ok, ok)
    if (!ok) assert.equal((r as { failure: { class: string } }).failure.class, cls)
    const rec = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0]!) as { argv: string[] }
    assert.ok(!rec.argv.includes('--json-schema'), '不使用 --json-schema（多一轮对话）')
  })
}

test('思考：profile 未指定 effort 时关闭扩展思考；指定了 effort 时只由 --effort 决定', async (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const log = join(sb.root, 'fake.jsonl')
  const env = sb.env({ FAKE_LOG: log, MAX_THINKING_TOKENS: '32000', CLAUDE_EFFORT: 'max' })
  await claudeBackend(profile(), env).invoke(req())
  await claudeBackend(profile({ effort: 'low' }), env).invoke(req())
  const [plain, withEffort] = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> })
  assert.equal(plain!.env.MAX_THINKING_TOKENS, '0')
  assert.ok(!plain!.argv.includes('--effort'))
  assert.equal(withEffort!.env.MAX_THINKING_TOKENS, undefined)
  assert.equal(withEffort!.argv[withEffort!.argv.indexOf('--effort') + 1], 'low')
})

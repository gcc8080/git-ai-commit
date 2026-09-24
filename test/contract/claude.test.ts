// 合同测试：真实调用 claude（会消耗额度）。只有设置 AI_COMMIT_CONTRACT=1 时运行。
// git 操作使用隔离的夹具环境；后端使用真实环境（登录凭证依赖真实的 HOME）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Sandbox } from '../helpers/repo.ts'
import { Git } from '../../src/git/git.ts'
import { captureSnapshot } from '../../src/git/snapshot.ts'
import { buildModelInput } from '../../src/input/build.ts'
import { effectiveRules } from '../../src/config/rules.ts'
import { claudeBackend } from '../../src/backend/claude.ts'
import { generateWith } from '../../src/generate.ts'
import { validateOutput } from '../../src/output/schema.ts'

const enabled = process.env.AI_COMMIT_CONTRACT === '1'

test('claude：在夹具仓库中完成一次真实提交，消息通过 schema 校验', { skip: !enabled && '设置 AI_COMMIT_CONTRACT=1 运行' }, async (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const repo = sb.repo()
  repo.write('src/cache.ts', 'export class Cache {\n  get(key: string) {\n    return this.store.get(key)\n  }\n}\n')
  repo.git(['add', '.']); repo.git(['commit', '-q', '-m', 'feat: add cache'])
  repo.write('src/cache.ts', 'export class Cache {\n  get(key: string) {\n    const hit = this.store.get(key)\n    if (hit && Date.now() - hit.at > this.ttl) {\n      this.store.delete(key)\n      return undefined\n    }\n    return hit?.value\n  }\n}\n')
  repo.git(['add', '.'])

  const git = new Git(repo.dir, sb.env())
  const rules = effectiveRules({})
  const input = buildModelInput(git, captureSnapshot(git), rules)
  const backend = claudeBackend({ name: 'claude-haiku', harness: 'claude', model: 'haiku', provider: null, effort: null, executable: null }, process.env)
  const started = performance.now()
  const r = await generateWith(backend, input, { rules, deadline: performance.now() + 120_000, signal: new AbortController().signal })
  const ms = Math.round(performance.now() - started)
  assert.equal(r.ok, true, JSON.stringify(r))
  if (!r.ok) return
  assert.equal(validateOutput(r.candidate, { rules, inputText: input.data }).ok, true)
  repo.git(['commit', '-q', '-F', '-'], { input: r.message + '\n' })
  const committed = repo.git(['log', '-1', '--format=%B']).stdout.trim()
  assert.equal(committed, r.message)
  t.diagnostic(`耗时 ${ms}ms，纠正：${r.corrected}`)
  t.diagnostic(`提交信息：${JSON.stringify(committed)}`)
})

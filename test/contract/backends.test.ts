// 合同测试：真实调用 codex、pi、opencode（会消耗额度）。只有设置 AI_COMMIT_CONTRACT=1 时运行。
// 模型可用环境变量覆盖：AI_COMMIT_CODEX_MODEL、AI_COMMIT_PI_PROVIDER、AI_COMMIT_PI_MODEL、AI_COMMIT_OPENCODE_MODEL。
// git 操作使用隔离的夹具环境；后端使用真实环境（登录凭证依赖真实的 HOME）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Sandbox } from '../helpers/repo.ts'
import { Git } from '../../src/git/git.ts'
import { captureSnapshot } from '../../src/git/snapshot.ts'
import { buildModelInput } from '../../src/input/build.ts'
import { effectiveRules } from '../../src/config/rules.ts'
import { createBackend } from '../../src/backend/registry.ts'
import { OPENCODE_TITLE } from '../../src/backend/opencode.ts'
import { generateWith } from '../../src/generate.ts'
import { validateOutput } from '../../src/output/schema.ts'
import type { Profile } from '../../src/config/machine.ts'

const enabled = process.env.AI_COMMIT_CONTRACT === '1'
const skip = !enabled && '设置 AI_COMMIT_CONTRACT=1 运行'
const MARKER = 'CONTRACT_MARKER_7f3a91'

const PROFILES: Record<'codex' | 'pi' | 'opencode', Profile> = {
  codex: { name: 'codex', harness: 'codex', model: process.env.AI_COMMIT_CODEX_MODEL ?? 'gpt-5.5', provider: null, effort: 'low', executable: null },
  pi: { name: 'pi', harness: 'pi', model: process.env.AI_COMMIT_PI_MODEL ?? 'gpt-5.5', provider: process.env.AI_COMMIT_PI_PROVIDER ?? 'openai-codex', effort: 'low', executable: null },
  opencode: { name: 'opencode', harness: 'opencode', model: process.env.AI_COMMIT_OPENCODE_MODEL ?? 'deepseek/deepseek-flash', provider: null, effort: null, executable: null },
}

function fixture(sb: Sandbox) {
  const repo = sb.repo()
  repo.write('src/cache.ts', 'export class Cache {\n  get(key: string) {\n    return this.store.get(key)\n  }\n}\n')
  repo.git(['add', '.']); repo.git(['commit', '-q', '-m', 'feat: add cache'])
  repo.write('src/cache.ts', `export class Cache {\n  // ${MARKER}\n  get(key: string) {\n    const hit = this.store.get(key)\n    if (hit && Date.now() - hit.at > this.ttl) {\n      this.store.delete(key)\n      return undefined\n    }\n    return hit?.value\n  }\n}\n`)
  repo.git(['add', '.'])
  const git = new Git(repo.dir, sb.env())
  const rules = effectiveRules({})
  return { repo, rules, input: buildModelInput(git, captureSnapshot(git), rules) }
}

/** 本工具在 opencode 中留下的会话（按标题）。在非 git 的临时目录中列出，与调用时的工作目录一致。 */
function opencodeSessions(): Array<{ id: string; title: string; created: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'aic-oc-'))
  try {
    const r = spawnSync('opencode', ['session', 'list', '--format', 'json'], { cwd: dir, encoding: 'utf8', timeout: 30_000 })
    const out = (r.stdout ?? '').trim()
    return (out === '' ? [] : JSON.parse(out) as Array<{ id: string; title: string; created: number }>).filter((s) => s.title === OPENCODE_TITLE)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const harness of ['codex', 'pi', 'opencode'] as const) {
  test(`${harness}：在夹具仓库中完成一次真实提交，消息通过 schema 校验`, { skip, timeout: 180_000 }, async (t) => {
    const sb = new Sandbox()
    t.after(() => sb.cleanup())
    const { repo, rules, input } = fixture(sb)
    const before = harness === 'opencode' ? opencodeSessions().length : 0
    const started = performance.now()
    const r = await generateWith(createBackend(PROFILES[harness]), input, { rules, deadline: performance.now() + 150_000, signal: new AbortController().signal })
    const ms = Math.round(performance.now() - started)
    assert.equal(r.ok, true, JSON.stringify(r))
    if (!r.ok) return
    assert.equal(validateOutput(r.candidate, { rules, inputText: input.data }).ok, true)
    repo.git(['commit', '-q', '-F', '-'], { input: r.message + '\n' })
    assert.equal(repo.git(['log', '-1', '--format=%B']).stdout.trim(), r.message)
    if (harness === 'opencode') assert.equal(opencodeSessions().length, before, '调用结束后不应留下本工具的会话')
    t.diagnostic(`模型 ${PROFILES[harness].model}，耗时 ${ms}ms，纠正：${r.corrected}`)
    t.diagnostic(`提交信息：${JSON.stringify(r.message)}`)
  })
}

test('codex：模型不存在时失败，原因只有一行且不含 prompt 内容', { skip, timeout: 120_000 }, async (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const { input } = fixture(sb)
  const backend = createBackend({ ...PROFILES.codex, model: 'no-such-model-for-contract' })
  const r = await backend.invoke({ prompt: input.prompt, deadline: performance.now() + 100_000, signal: new AbortController().signal })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.ok(!r.failure.message.includes('\n'), r.failure.message)
  assert.ok(!r.failure.message.includes(MARKER), r.failure.message)
  t.diagnostic(`分类 ${r.failure.class}：${r.failure.message}`)
})

test('pi：模型标识不精确时报配置错误，不发起生成', { skip, timeout: 60_000 }, async () => {
  const backend = createBackend({ ...PROFILES.pi, model: 'gpt-5' })
  const r = await backend.invoke({ prompt: 'P', deadline: performance.now() + 30_000, signal: new AbortController().signal })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.failure.class, 'config')
})

test('opencode：超时取消后，残留会话可以按标题列出', { skip, timeout: 120_000 }, async (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const { input } = fixture(sb)
  const before = new Set(opencodeSessions().map((s) => s.id))
  const r = await createBackend(PROFILES.opencode).invoke({ prompt: input.prompt, deadline: performance.now() + 2500, signal: new AbortController().signal })
  assert.equal(r.ok ? null : r.failure.class, 'timeout')
  const residue = opencodeSessions().filter((s) => !before.has(s.id))
  t.diagnostic(`超时后残留的本工具会话：${residue.length} 个`)
  for (const s of residue) spawnSync('opencode', ['session', 'delete', s.id], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(opencodeSessions().filter((s) => !before.has(s.id)).length, 0)
})

// 8.3 失败语义的合同测试（D14、[评审] C03）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Sandbox, type Repo } from '../helpers/repo.ts'
import { COUNTER, installPrepareHook, lineCount, writeMachineConfig } from '../helpers/setup.ts'

type Mode = 'none' | 'valid' | 'invalid' | 'counter'

function prepare(repo: Repo, mode: Mode) {
  const hook = join(repo.gitPath('hooks'), 'prepare-commit-msg')
  rmSync(hook, { force: true })
  if (mode === 'valid') installPrepareHook(repo)
  if (mode === 'invalid') installPrepareHook(repo, { node: '/nonexistent/node' })
  if (mode === 'counter') installPrepareHook(repo, { script: COUNTER })
}

interface Outcome { status: number; committed: boolean; subject: string }

function attempt(repo: Repo, args: string[], env: Record<string, string>, mode: Mode): Outcome {
  prepare(repo, mode)
  repo.write(`f-${Math.random().toString(36).slice(2)}.txt`, 'x\n')
  repo.git(['add', '-A'])
  const before = repo.git(['rev-parse', 'HEAD']).stdout.trim()
  const r = repo.git(['commit', '-q', ...args], { env, allowFail: true })
  const after = repo.git(['rev-parse', 'HEAD']).stdout.trim()
  const committed = before !== after
  const subject = committed ? repo.git(['log', '-1', '--format=%s']).stdout.trim() : ''
  if (!committed) repo.git(['reset', '-q', '--hard'])
  return { status: r.status === 0 ? 0 : 1, committed, subject }
}

test('8.3 不打开编辑器且生成失败：空消息、只剩签名行、空模板都由 Git 中止', (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const repo = sb.repo()
  writeMachineConfig(sb)
  const env = { FAKE_SCENARIO: 'nonzero' }
  const emptyTmpl = repo.write('../empty.tmpl', '')
  for (const [name, args] of [['空消息', ['--no-edit']], ['只剩签名行', ['-s', '--no-edit']], ['空模板', ['-t', emptyTmpl, '--no-edit']]] as const) {
    const o = attempt(repo, [...args], env, 'valid')
    assert.equal(o.committed, false, name)
    assert.equal(o.status, 1, name)
  }
})

test('8.3 C03 矩阵：-m、跳过开关、空提交、模板标题 × 运行时有效/失效 × 打开/不打开编辑器', (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const repo = sb.repo()
  writeMachineConfig(sb)
  const tmpl = repo.write('../title.tmpl', 'fix: preserve my intended message\n')
  const count = join(sb.root, 'count.log')
  const fakeLog = join(sb.root, 'fake.log')
  const cases: Array<{ name: string; args: string[]; env: Record<string, string>; shellFiltered: boolean }> = [
    { name: '-m', args: ['-m', 'manual'], env: {}, shellFiltered: true },
    { name: '跳过开关', args: ['--allow-empty-message'], env: { AI_COMMIT_SKIP: '1' }, shellFiltered: true },
    { name: '空提交', args: ['--allow-empty', '--allow-empty-message'], env: {}, shellFiltered: false },
    { name: '模板已有标题', args: ['-t', tmpl, '--allow-empty-message'], env: {}, shellFiltered: false },
  ]
  for (const c of cases) {
    for (const editor of ['打开编辑器', '不打开编辑器'] as const) {
      const args = editor === '不打开编辑器' ? [...c.args, '--no-edit'] : c.args
      const env = { ...c.env, GIT_EDITOR: 'true', FAKE_LOG: fakeLog, COUNTER_FILE: count }
      const label = `${c.name} / ${editor}`
      if (c.name === '空提交') {
        // 空提交：清空暂存后再提交（attempt 会暂存一个新文件，这里改为直接提交 HEAD 的内容）
        repo.git(['reset', '-q', '--hard'])
      }
      const baseline = c.name === '空提交' ? commitEmpty(repo, args, env, 'none') : attempt(repo, args, env, 'none')
      writeFileSync(count, '')
      const counted = c.name === '空提交' ? commitEmpty(repo, args, env, 'counter') : attempt(repo, args, env, 'counter')
      assert.equal(lineCount(count), c.shellFiltered ? 0 : 1, `${label}：入口计数`)
      void counted
      writeFileSync(fakeLog, '')
      const valid = c.name === '空提交' ? commitEmpty(repo, args, env, 'valid') : attempt(repo, args, env, 'valid')
      assert.equal(lineCount(fakeLog), 0, `${label}：不调用后端`)
      assert.deepEqual(valid, baseline, `${label}：运行时有效时与不装 hook 一致`)
      const invalid = c.name === '空提交' ? commitEmpty(repo, args, env, 'invalid') : attempt(repo, args, env, 'invalid')
      assert.deepEqual(invalid, baseline, `${label}：运行时失效时与不装 hook 一致`)
    }
  }
})

function commitEmpty(repo: Repo, args: string[], env: Record<string, string>, mode: Mode): Outcome {
  prepare(repo, mode)
  const before = repo.git(['rev-parse', 'HEAD']).stdout.trim()
  const r = repo.git(['commit', '-q', ...args], { env, allowFail: true })
  const after = repo.git(['rev-parse', 'HEAD']).stdout.trim()
  return { status: r.status === 0 ? 0 : 1, committed: before !== after, subject: before !== after ? repo.git(['log', '-1', '--format=%s']).stdout.trim() : '' }
}

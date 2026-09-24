// 11.1 第一期端到端验收（真实 claude 后端，会消耗额度）。只有设置 AI_COMMIT_CONTRACT=1 时运行。
// 在本项目的一个 clone 副本中安装，依次执行 git commit、-s、-v、--no-edit、-m，再在全局配置了空 commit.template 的环境下重复一遍。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { BUNDLE, FIXTURES, ROOT } from '../helpers/paths.ts'

const enabled = process.env.AI_COMMIT_CONTRACT === '1'
const CJK = /[一-鿿]/
const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)\s]+\))?!?: \S/

test('第一期端到端：真实仓库副本 + 真实 claude', { skip: !enabled && '设置 AI_COMMIT_CONTRACT=1 运行', timeout: 30 * 60_000 }, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aic-e2e-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const xdg = join(root, 'xdg')
  mkdirSync(join(xdg, 'git-ai-commit'), { recursive: true })
  writeFileSync(join(xdg, 'git-ai-commit', 'config.json'), JSON.stringify({
    defaultProfile: 'claude-haiku',
    profiles: { 'claude-haiku': { harness: 'claude', model: 'haiku' } },
    timeoutMs: 120_000,
  }))
  const emptyTemplate = join(root, 'empty.tmpl')
  writeFileSync(emptyTemplate, '')
  const plainGlobal = join(root, 'gitconfig-plain')
  writeFileSync(plainGlobal, '[user]\n\tname = E2E\n\temail = e2e@example.com\n')
  const templateGlobal = join(root, 'gitconfig-template')
  writeFileSync(templateGlobal, `[user]\n\tname = E2E\n\temail = e2e@example.com\n[commit]\n\ttemplate = ${emptyTemplate}\n`)
  const starts = join(root, 'node-starts.log')

  const env = (globalConfig: string): NodeJS.ProcessEnv => ({
    ...process.env,
    XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_EDITOR: 'true',
    LC_ALL: 'C',
    NODE_OPTIONS: `--require ${join(FIXTURES, 'node-start-counter.cjs')}`,
    NODE_START_LOG: starts,
  })
  const run = (cmd: string, args: string[], e: NodeJS.ProcessEnv, input?: string) => {
    const r = spawnSync(cmd, args, { cwd: repo, env: e, encoding: 'utf8', input, timeout: 300_000 })
    return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }

  assert.equal(spawnSync('git', ['clone', '-q', '--no-hardlinks', ROOT, repo]).status, 0)
  const installed = run(process.execPath, [BUNDLE, 'install'], env(plainGlobal))
  assert.equal(installed.status, 0, installed.stderr)

  const changes: Array<[string, string]> = [
    ['src/util/clamp.ts', 'export function clamp(n: number, lo: number, hi: number): number {\n  return Math.min(hi, Math.max(lo, n))\n}\n'],
    ['src/util/sleep.ts', 'export function sleep(ms: number): Promise<void> {\n  return new Promise((r) => setTimeout(r, ms))\n}\n'],
    ['docs/usage.md', '# 使用说明\n\n安装后照常执行 git commit 即可。\n'],
    ['src/util/chunk.ts', 'export function chunk<T>(xs: T[], n: number): T[][] {\n  const out: T[][] = []\n  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))\n  return out\n}\n'],
    ['src/util/unique.ts', 'export const unique = <T>(xs: T[]): T[] => [...new Set(xs)]\n'],
  ]
  const variants: Array<[string, string[]]> = [['git commit', []], ['git commit -s', ['-s']], ['git commit -v', ['-v']], ['git commit --no-edit', ['--no-edit']], ['git commit -m', ['-m', 'chore: 手写的提交信息']]]

  for (const [round, globalConfig] of [['无模板', plainGlobal], ['空 commit.template', templateGlobal]] as const) {
    for (const [i, [label, args]] of variants.entries()) {
      const [file, content] = changes[i]!
      const target = join(repo, file.replace(/\.(ts|md)$/, `-${round === '无模板' ? 'a' : 'b'}.$1`))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
      assert.equal(run('git', ['add', '-A'], env(globalConfig)).status, 0)
      writeFileSync(starts, '')
      const before = run('git', ['rev-parse', 'HEAD'], env(globalConfig)).stdout
      const t0 = performance.now()
      const r = run('git', ['commit', '-q', ...args], env(globalConfig))
      const ms = Math.round(performance.now() - t0)
      const after = run('git', ['rev-parse', 'HEAD'], env(globalConfig)).stdout
      const msg = run('git', ['log', '-1', '--format=%B'], env(globalConfig)).stdout.trim()
      const nodeStarts = readFileSync(starts, 'utf8').split('\n').filter((l) => l.includes('hook prepare-commit-msg')).length
      t.diagnostic(`[${round}] ${label}：${ms}ms，主程序启动 ${nodeStarts} 次，消息 ${JSON.stringify(msg)}`)
      assert.equal(r.status, 0, `${round} ${label}：${r.stderr}`)
      assert.notEqual(after, before, `${round} ${label}：已提交`)
      if (label === 'git commit -m') {
        assert.equal(nodeStarts, 0, '-m 不启动主程序')
        assert.equal(msg, 'chore: 手写的提交信息')
        continue
      }
      assert.equal(nodeStarts, 1, `${round} ${label}：主程序启动一次`)
      const header = msg.split('\n')[0]!
      assert.match(header, CONVENTIONAL, `${round} ${label}：conventional 格式`)
      assert.match(header, CJK, `${round} ${label}：中文`)
      if (label === 'git commit -s') assert.match(msg, /\n\nSigned-off-by: E2E <e2e@example\.com>$/, '保留签名行')
      if (label === 'git commit -v') assert.equal(msg.includes('diff --git'), false)
    }
  }
})

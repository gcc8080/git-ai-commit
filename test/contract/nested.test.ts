// 14.3 合同测试：在 Claude Code 会话中执行不带 -m 的 git commit（真实 claude 后端，会消耗额度）。
// 只有设置 AI_COMMIT_CONTRACT=1、且当前环境确实处在 Claude Code 会话中（CLAUDECODE 已设置）时运行。
// 期望：要么正常生成，要么按 D14 放行（消息文件不变、一行诊断、hook 以 0 退出，由 Git 原生规则决定提交结果）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUNDLE } from '../helpers/paths.ts'

const enabled = process.env.AI_COMMIT_CONTRACT === '1'
const nested = (process.env.CLAUDECODE ?? '') !== ''
const skip = !enabled ? '设置 AI_COMMIT_CONTRACT=1 运行' : !nested ? '需要在 Claude Code 会话中运行' : false

test('在 Claude Code 会话中执行 git commit：正常生成或按 D14 放行', { skip, timeout: 180_000 }, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aic-nested-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const xdg = join(root, 'xdg')
  mkdirSync(join(xdg, 'git-ai-commit'), { recursive: true })
  writeFileSync(join(xdg, 'git-ai-commit', 'config.json'), JSON.stringify({
    defaultProfile: 'claude-haiku', profiles: { 'claude-haiku': { harness: 'claude', model: 'haiku' } }, timeoutMs: 120_000,
  }))
  const globalConfig = join(root, 'gitconfig')
  writeFileSync(globalConfig, '[user]\n\tname = Nested\n\temail = nested@example.com\n[init]\n\tdefaultBranch = main\n')
  // 保留当前进程的全部环境（包括 CLAUDECODE 等 Claude Code 设置的变量），只隔离 git 配置与本工具配置
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_EDITOR: 'true', LC_ALL: 'C' }
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { cwd: repo, env, encoding: 'utf8', timeout: 170_000 })
    return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
  mkdirSync(repo)
  assert.equal(run('git', ['init', '-q']).status, 0)
  writeFileSync(join(repo, 'README.md'), '# demo\n')
  run('git', ['add', '.']); run('git', ['commit', '-q', '-m', 'chore: init'])
  assert.equal(run(process.execPath, [BUNDLE, 'install']).status, 0)
  writeFileSync(join(repo, 'greet.ts'), 'export const greet = (name: string) => `你好，${name}`\n')
  run('git', ['add', '.'])

  const r = run('git', ['commit'])
  const subject = run('git', ['log', '-1', '--format=%s']).stdout.trim()
  if (r.status === 0 && subject !== 'chore: init') {
    assert.match(subject, /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)\s]+\))?!?: \S/)
    t.diagnostic(`正常生成：${subject}`)
  } else {
    // 放行：hook 以 0 退出，提交由 Git 原生规则中止（空消息），且只有本工具的一行失败诊断
    assert.match(r.stderr, /Aborting commit due to empty commit message/)
    const diag = r.stderr.split('\n').filter((l) => l.startsWith('ai-commit:') && !l.includes('正在用') && !l.includes('未验证状态'))
    assert.equal(diag.length, 1, r.stderr)
    t.diagnostic(`按 D14 放行：${diag[0]}`)
  }
})

// 第三期测试辅助：用真实的 install 安装并开启预热、等待后台任务结束、读取调用日志与缓存。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Repo } from './repo.ts'
import { BUNDLE } from './paths.ts'
import { parseOwnership } from '../../src/hook/templates.ts'
import { statePaths, type StatePaths } from '../../src/prewarm/store.ts'

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function cli(repo: Repo, args: string[], env: Record<string, string> = {}, cwd = repo.dir) {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { cwd, env: repo.sandbox.env(env), encoding: 'utf8', timeout: 60_000 })
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** 开启 aicommit.prewarm 后执行真实的 install；返回安装标识。 */
export function installWithPrewarm(repo: Repo, env: Record<string, string> = {}): string {
  repo.git(['config', 'aicommit.prewarm', 'true'])
  const r = cli(repo, ['install'], env)
  assert.equal(r.status, 0, r.stderr)
  const hook = readFileSync(join(repo.gitPath('hooks'), 'post-index-change'), 'utf8')
  const own = parseOwnership(hook)
  assert.ok(own !== null, '已安装 post-index-change')
  return own.installId
}

export function stateOf(repo: Repo, installId: string): StatePaths {
  return statePaths(join(repo.gitPath('ai-commit'), installId))
}

function warmProcesses(installId: string): string[] {
  const r = spawnSync('ps', ['-A', '-ww', '-o', 'command='], { encoding: 'utf8' })
  return r.stdout.split('\n').filter((l) => l.includes(`warm --install-id ${installId}`))
}

/** 等待该安装的后台任务全部结束（包括 hook 刚启动、尚未出现在进程表中的那一小段时间）。 */
export async function waitIdle(installId: string, timeoutMs = 30_000): Promise<void> {
  await sleep(400)
  const until = Date.now() + timeoutMs
  while (warmProcesses(installId).length > 0) {
    if (Date.now() > until) throw new Error(`后台任务在 ${timeoutMs}ms 内没有结束：${warmProcesses(installId).join(' | ')}`)
    await sleep(100)
  }
}

export interface FakeRecord {
  scenario: string
  argv: string[]
  pid: number
  othersAlive: number[]
  at: number
  stdin?: string
}

/** 假后端的生成调用记录（不含 opencode 的会话命令）。 */
export function calls(log: string): FakeRecord[] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as FakeRecord).filter((r) => r.scenario !== 'session')
}

export function cacheFiles(p: StatePaths): string[] {
  return existsSync(p.cache) ? readdirSync(p.cache).filter((n) => n.endsWith('.json')) : []
}

export function readyEntries(p: StatePaths): Array<{ candidate: { subject: string }; producedBy: { profile: string } }> {
  return cacheFiles(p).map((n) => JSON.parse(readFileSync(join(p.cache, n), 'utf8')) as { state: string; candidate: { subject: string }; producedBy: { profile: string } }).filter((e) => e.state === 'ready')
}

// 性能测量（D3、D17）：预热 hook 对 git add 的开销、缓存命中路径的耗时。只有设置 AI_COMMIT_PERF=1 时运行。
// 计时对机器负载敏感：单独运行，不与其他测试并发。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Sandbox } from '../helpers/repo.ts'
import { BUNDLE } from '../helpers/paths.ts'
import { COUNTER, writeMachineConfig } from '../helpers/setup.ts'
import { cacheFiles, installWithPrewarm, stateOf, waitIdle } from '../helpers/prewarm.ts'
import { postIndexChangeTemplate } from '../../src/hook/templates.ts'

const enabled = process.env.AI_COMMIT_PERF === '1'
const skip = !enabled && '设置 AI_COMMIT_PERF=1 运行'
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

test('15.4 真实生成的 post-index-change：全部通过路径的额外开销 ≤50ms', { skip }, (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const repo = sb.repo('my repo')
  const hooks = repo.gitPath('hooks')
  mkdirSync(hooks, { recursive: true })
  const hook = join(hooks, 'post-index-change')
  const env = sb.env()
  repo.write('keep.txt', 'k\n')
  repo.git(['add', 'keep.txt'])
  let i = 0
  const addOnce = () => {
    writeFileSync(join(repo.dir, 'f.txt'), `${i++}\n`)
    const s = performance.now()
    spawnSync('git', ['add', 'f.txt'], { cwd: repo.dir, env })
    return performance.now() - s
  }
  // 主程序入口换成立即退出的计数器：只测 hook 的同步部分，避免后台任务的 CPU 占用干扰测量
  const writeHook = () => { writeFileSync(hook, postIndexChangeTemplate({ node: process.execPath, script: COUNTER, installId: 't' })); chmodSync(hook, 0o755) }
  const groups: Record<string, () => void> = {
    none: () => rmSync(hook, { force: true }),
    off: () => { writeHook(); repo.git(['config', 'aicommit.prewarm', 'false']) },
    pass: () => { writeHook(); repo.git(['config', 'aicommit.prewarm', 'true']) },
  }
  const result: Record<string, number[]> = {}
  for (let round = 0; round < 2; round++) {
    for (const [name, arrange] of Object.entries(groups)) {
      arrange()
      for (let w = 0; w < 3; w++) addOnce()
      ;(result[name] ??= []).push(mean(Array.from({ length: 30 }, addOnce)))
    }
  }
  const extra = (name: string) => result[name]!.map((x, k) => x - result.none![k]!)
  t.diagnostic(`git add 平均耗时（两轮）：不装 hook ${result.none!.map((x) => x.toFixed(1)).join(' / ')}ms；预热关闭 +${extra('off').map((x) => x.toFixed(1)).join(' / ')}ms；全部通过 +${extra('pass').map((x) => x.toFixed(1)).join(' / ')}ms`)
  assert.ok(Math.max(...extra('pass')) <= 50, `全部通过路径的额外开销超过 50ms：${extra('pass').join(', ')}`)
})

test('17.3 缓存命中路径：从 hook 启动到写入消息文件 ≤300ms', { skip }, async (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  writeMachineConfig(sb, { debounceMs: 200 })
  const repo = sb.repo()
  const id = installWithPrewarm(repo)
  repo.write('a.txt', 'a\n')
  repo.git(['add', 'a.txt'])
  await waitIdle(id)
  const p = stateOf(repo, id)
  const sizes = cacheFiles(p).map((f) => statSync(join(p.cache, f)).size)
  // git 运行 hook 时会把自己的 exec-path 放到 PATH 最前面：复现这一点，让主程序与 hook 一样直接调用 git 本体
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim()
  const msgFile = join(repo.dir, '.git', 'COMMIT_EDITMSG')
  const run = (envPath: string) => {
    writeFileSync(msgFile, '')
    const s = performance.now()
    const r = spawnSync(process.execPath, [BUNDLE, 'hook', 'prepare-commit-msg', '--install-id', id, '--', '.git/COMMIT_EDITMSG', ''], { cwd: repo.dir, env: repo.sandbox.env({ PATH: envPath }), encoding: 'utf8' })
    const ms = performance.now() - s
    assert.equal(r.status, 0, r.stderr)
    assert.match(readFileSync(msgFile, 'utf8'), /^fix: /)
    return ms
  }
  const viaGit = Array.from({ length: 9 }, () => run(`${execPath}:${process.env.PATH}`))
  const direct = Array.from({ length: 9 }, () => run(process.env.PATH ?? ''))
  t.diagnostic(`命中路径中位数：经 git 调用（PATH 含 exec-path）${Math.round(median(viaGit))}ms；直接调用 ${Math.round(median(direct))}ms；缓存条目 ${sizes.join('、')} 字节`)
  assert.ok(median(viaGit) <= 300, `命中路径中位数 ${Math.round(median(viaGit))}ms 超过 300ms`)
})

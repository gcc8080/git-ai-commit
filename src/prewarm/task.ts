// 后台预热任务（D16、D19）：由 post-index-change 以脱离方式启动，运行在自己的进程组中，全程不向终端输出。
// 执行顺序：在已存在的状态目录中排他创建登记文件（从不创建目录）→ 去抖 → 复核授权、跳过条件与特殊流程，并重新计算快照
// （base 等于 target 就退出）→ 以最新快照为准取代其他后台任务 → 取得生成权 → 确认锁文件仍在原路径 → 发送 → 发布。
// 被接管或卸载终止时直接退出：锁与登记留给后来者按身份核对后清理，旧任务既不发布也不删新代次的锁。
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadContext } from '../commands/context.ts'
import { generateFrom, prepare } from '../commands/generate-flow.ts'
import { probeCapability } from '../backend/capability.ts'
import { captureSnapshot } from '../git/snapshot.ts'
import { specialState } from '../git/state.ts'
import { envSkip } from '../hook/prepare.ts'
import { stateDir } from '../install/paths.ts'
import { SCHEMA_VERSION } from '../output/schema.ts'
import type { Git } from '../git/git.ts'
import { keyFor } from './cached.ts'
import { CACHE_MAX_AGE_MS, CACHE_MAX_ENTRIES, FAILED_COOLDOWN_MS, staleMs } from './policy.ts'
import {
  createLock, latest, listLocks, lockExists, prune, publish, readEntry, readRegistration, readRegistrations, register, releaseLock,
  removeLowerLocks, setLatest, statePaths, unregister, updateRegistration, type Registration,
} from './store.ts'
import { holderOfLock, holderOfTask, takeover } from './takeover.ts'

export type TaskOutcome = 'published' | 'failed' | 'skipped'

export interface TaskOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  installId: string
  token: string
  /** 测试用：在命名的检查点暂停。 */
  barrier?: (name: string) => Promise<void>
}

/** 执行时授权（D15）：每次都重新读取，值不是 true 就放弃。 */
export function prewarmEnabled(git: Git): boolean {
  return git.tryText(['config', '--bool', 'aicommit.prewarm']) === 'true'
}

/** 测试用屏障：设置了 AI_COMMIT_TEST_BARRIER（目录）时，在检查点写入 <名称>.<pid> 并等待 <名称>.go 出现。 */
export function barrierFromEnv(env: NodeJS.ProcessEnv): ((name: string) => Promise<void>) | undefined {
  const dir = env.AI_COMMIT_TEST_BARRIER
  if (!dir) return undefined
  return async (name) => {
    try { writeFileSync(join(dir, `${name}.${process.pid}`), '') } catch { return }
    const until = Date.now() + 60_000
    while (!existsSync(join(dir, `${name}.go`)) && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function runWarmTask(o: TaskOptions): Promise<TaskOutcome> {
  await o.barrier?.('start')
  const ctx = loadContext(o.cwd, o.env)
  const top = ctx.git.tryText(['rev-parse', '--show-toplevel'])
  if (top === null) return 'skipped'
  const p = statePaths(stateDir(top, o.installId, o.env))
  const reg: Registration = { pid: process.pid, pgid: process.pid, token: o.token, phase: 'debounce', key: null, startedAt: Date.now() }
  // 目录不存在（未安装、已卸载或正在卸载）就放弃：从不创建目录
  if (!register(p, reg)) return 'skipped'
  let held: { key: string; gen: number } | null = null
  try {
    if (!setLatest(p, o.token)) return 'skipped'
    await o.barrier?.('registered')
    await sleep(ctx.machine.config.debounceMs)
    // 去抖：窗口内有更新的触发就交给它
    if (latest(p) !== o.token) return 'skipped'
    // 复核：授权、跳过条件、特殊流程
    if (!prewarmEnabled(ctx.git) || envSkip(o.env) !== null || specialState(ctx.git) !== null) return 'skipped'
    // 重新计算快照：提交已在窗口内完成（包括 git commit -m）或暂存已被撤回时 base 等于 target
    const snapshot = captureSnapshot(ctx.git)
    if (snapshot.unborn || snapshot.empty) return 'skipped'
    const prep = prepare(ctx, snapshot, undefined)
    if (!prep.ok) return 'skipped'
    const deadline = performance.now() + ctx.machine.config.timeoutMs
    const cap = await probeCapability(prep.prepared.profile, ctx.env, { deadline })
    if (cap.state === 'incompatible' || (cap.state === 'unverified' && ctx.machine.config.strict)) return 'skipped'
    const key = await keyFor(ctx, snapshot, prep.prepared, deadline)
    const entry = readEntry(p, key, ctx.rules)
    if (entry?.state === 'ready') return 'skipped'
    if (entry?.state === 'failed' && Date.now() - entry.createdAt < FAILED_COOLDOWN_MS) return 'skipped'
    const stale = staleMs(ctx.machine.config.timeoutMs)

    // 每个 worktree 至多一个后台生成任务，以最新快照为准：其他 key 上比自己新的任务在生成就退出，比自己旧的按接管规则终止，
    // 并清理它留下的锁与登记。同一个 key 上的任务交给锁裁决（同一代次只有一个创建者）。
    let current: Registration = { ...reg, phase: 'generating', key }
    if (!updateRegistration(p, current)) return 'skipped'
    const older = (r: Registration) => r.startedAt < reg.startedAt || (r.startedAt === reg.startedAt && r.token < reg.token)
    for (const other of readRegistrations(p)) {
      if (other.token === o.token || other.phase !== 'generating' || other.key === key) continue
      if (!older(other)) return 'skipped'
      if ((await takeover(holderOfTask(other), { force: true, staleMs: stale }, () => readRegistration(p, other.token)?.backend)) === 'unconfirmed') return 'skipped'
      if (other.key !== null) for (const l of listLocks(p, other.key)) if (l.info?.token === other.token) releaseLock(p, other.key, l.gen)
      unregister(p, other.token)
    }
    await o.barrier?.('before-lock')

    // 取得生成权：当前持有者（前台或其他任务）还在且未超龄就不接管
    const top = listLocks(p, key).at(-1)
    const topInfo = top?.info
    if (topInfo && (await takeover(holderOfLock(topInfo), { force: false, staleMs: stale }, () => readRegistration(p, topInfo.token)?.backend)) !== 'gone') return 'skipped'
    const gen = (top?.gen ?? 0) + 1
    if (!createLock(p, { key, gen, kind: 'background', pid: process.pid, pgid: process.pid, token: o.token, startedAt: Date.now() })) return 'skipped'
    held = { key, gen }
    removeLowerLocks(p, key, gen)

    await o.barrier?.('before-send')
    // 发送前最后确认：锁文件仍在原路径（目录没有被卸载改名）、仍是最新的触发、授权仍然开启
    if (!lockExists(p, key, gen) || latest(p) !== o.token || !prewarmEnabled(ctx.git)) return 'skipped'
    const ac = new AbortController()
    const r = await generateFrom(ctx, prep.prepared, deadline, {
      signal: ac.signal,
      // 登记后端的进程组：接管或卸载终止本任务的进程组之后，据此连带终止后端
      onBackendSpawn: (pid, profile) => {
        current = { ...current, backend: { pgid: pid, command: profile.executable ?? profile.harness } }
        updateRegistration(p, current)
      },
    })
    await o.barrier?.('before-publish')
    const now = Date.now()
    if (r.ok) {
      const producer = ctx.machine.config.profiles.get(r.backend)
      publish(p, key, gen, {
        v: SCHEMA_VERSION, state: 'ready', key, candidate: r.candidate, profile: prep.prepared.profile.name,
        producedBy: { profile: r.backend, harness: producer?.harness ?? '', model: producer?.model ?? '' }, createdAt: now,
      })
      prune(p, { maxEntries: CACHE_MAX_ENTRIES, maxAgeMs: CACHE_MAX_AGE_MS })
      return 'published'
    }
    if (r.failure.class !== 'cancelled') publish(p, key, gen, { v: SCHEMA_VERSION, state: 'failed', key, failureClass: r.failure.class, createdAt: now })
    return 'failed'
  } catch {
    return 'failed'
  } finally {
    if (held !== null) releaseLock(p, held.key, held.gen)
    unregister(p, o.token)
  }
}

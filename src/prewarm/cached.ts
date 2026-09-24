// 前台（prepare-commit-msg、preview）与缓存、锁的协作（D5、D16）：
// - ready：直接使用；
// - 同 key 为 running：在剩余预算内等待，不重复发请求；持有者结束后仍没有结果，就自己取得生成权；
// - absent 或 failed：以排他方式建立下一代次的锁，同步生成，发布结果；
// - 强制刷新（preview --refresh）：按接管规则终止当前的后台持有者并确认退出后，建立下一代次的锁再生成。
// 等待、生成、纠正与回退共用同一个总预算（D17）。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Git } from '../git/git.ts'
import type { Snapshot } from '../git/snapshot.ts'
import type { Context } from '../commands/context.ts'
import { generateFrom, prepare, type FlowOptions, type FlowResult, type Prepared } from '../commands/generate-flow.ts'
import { probeCapability } from '../backend/capability.ts'
import { renderMessage } from '../output/render.ts'
import { SCHEMA_VERSION } from '../output/schema.ts'
import { hooksLocation } from '../install/paths.ts'
import { ensureStateDirs, installedId } from '../install/hooks.ts'
import { cacheKey } from './key.ts'
import { sampleHistory } from '../input/history.ts'
import { CACHE_MAX_AGE_MS, CACHE_MAX_ENTRIES, POLL_MS, staleMs } from './policy.ts'
import { createLock, listLocks, lockExists, prune, publish, readEntry, readRegistration, releaseLock, removeLowerLocks, statePaths, type Entry, type StatePaths } from './store.ts'
import { holderOfLock, holderState, takeover } from './takeover.ts'

export interface CachedOptions extends FlowOptions {
  installId: string | null
  refresh?: boolean
}

/**
 * 前台使用的状态目录。不存在时可以创建（D19：状态目录只由 install 与前台创建），但只在本仓库确实以该安装标识安装着
 * （或经管理器手动接入）时才创建——卸载改名目录之后、移除 hook 之前的短暂窗口里，并发的提交不会把目录重建出来。
 */
export function foregroundState(git: Git, env: NodeJS.ProcessEnv, installId: string): StatePaths | null {
  const paths = git.paths()
  const top = paths?.toplevel ?? null
  if (paths === null || top === null) return null
  const dir = join(paths.path['ai-commit'], installId)
  if (!existsSync(join(dir, 'cache'))) {
    if (installId !== 'manual' && installedId(hooksLocation(git).defaultDir) !== installId) return null
    try {
      ensureStateDirs(top, installId, env)
    } catch {
      return null
    }
  }
  return statePaths(dir)
}

/** 前台持有者的身份标识：出现在本进程命令行中的脚本路径与子命令。 */
export function foregroundToken(): string {
  return [process.argv[1] ?? '', process.argv[2] ?? ''].join(' ').trim()
}

/** 缓存键只需要历史样本的提交 oid（一次 git log），不需要构造完整的模型输入。 */
export async function keyFor(ctx: Context, snapshot: Snapshot, prepared: Prepared, deadline: number): Promise<string> {
  const cap = await probeCapability(prepared.profile, ctx.env, { deadline })
  return cacheKey({
    base: snapshot.base, target: snapshot.target, profile: prepared.profile, backendVersion: cap.version,
    rules: ctx.rules, historyOids: sampleHistory(ctx.git, snapshot.head).map((h) => h.oid),
  })
}

function fromEntry(e: Entry & { state: 'ready' }, opts: FlowOptions): FlowResult {
  if (e.producedBy.profile !== e.profile) opts.onNotice?.(`使用预热结果：由回退后端 ${e.producedBy.profile}（${e.producedBy.harness} ${e.producedBy.model}）生成`)
  return { ok: true, message: renderMessage(e.candidate), candidate: e.candidate, backend: e.producedBy.profile, corrected: false, fromCache: true }
}

async function waitWhile(cond: () => boolean, deadline: number, signal: AbortSignal): Promise<boolean> {
  while (cond()) {
    if (signal.aborted || performance.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  return true
}

export async function generateCached(ctx: Context, snapshot: Snapshot, opts: CachedOptions): Promise<FlowResult> {
  const deadline = performance.now() + ctx.machine.config.timeoutMs
  const prep = prepare(ctx, snapshot, opts.profileFlag)
  if (!prep.ok) return { ok: false, failure: prep.failure, backend: null }
  const store = opts.installId === null ? null : foregroundState(ctx.git, ctx.env, opts.installId)
  if (store === null) return generateFrom(ctx, prep.prepared, deadline, opts)

  const key = await keyFor(ctx, snapshot, prep.prepared, deadline)
  if (!opts.refresh) {
    const hit = readEntry(store, key, ctx.rules)
    if (hit?.state === 'ready') return fromEntry(hit, opts)
  }

  // 取得生成权
  let gen = 0
  let waitedOnce = false
  for (;;) {
    if (opts.signal.aborted) return { ok: false, failure: { class: 'cancelled', message: '已取消' }, backend: null }
    const top = listLocks(store, key).at(-1)
    if (top?.info) {
      const token = top.info.token
      const st = await takeover(holderOfLock(top.info), { force: opts.refresh === true, staleMs: staleMs(ctx.machine.config.timeoutMs) }, () => readRegistration(store, token)?.backend)
      if (st !== 'gone') {
        // 同 key 正在生成（或确认不了持有者已退出）：在剩余预算内等待，不重复发请求
        if (!waitedOnce) opts.onWait?.()
        waitedOnce = true
        // 持有者被强制终止时锁文件会留在原地：等待期间定期核对持有者是否还活着
        const holder = holderOfLock(top.info)
        let polls = 0
        const finished = await waitWhile(() => lockExists(store, key, top.gen) && (++polls % 5 !== 0 || holderState(holder) !== 'gone'), deadline, opts.signal)
        const e = readEntry(store, key, ctx.rules)
        if (e?.state === 'ready' && !opts.refresh) return fromEntry(e, opts)
        if (!finished) {
          if (opts.signal.aborted) return { ok: false, failure: { class: 'cancelled', message: '已取消' }, backend: null }
          return { ok: false, failure: { class: 'timeout', message: '等待同一快照的生成任务超时' }, backend: null }
        }
        continue
      }
    }
    gen = (top?.gen ?? 0) + 1
    if (createLock(store, { key, gen, kind: 'foreground', pid: process.pid, pgid: null, token: foregroundToken(), startedAt: Date.now() })) break
  }

  try {
    removeLowerLocks(store, key, gen)
    const r = await generateFrom(ctx, prep.prepared, deadline, opts)
    const now = Date.now()
    if (r.ok) {
      const producer = ctx.machine.config.profiles.get(r.backend)
      publish(store, key, gen, {
        v: SCHEMA_VERSION, state: 'ready', key, candidate: r.candidate, profile: prep.prepared.profile.name,
        producedBy: { profile: r.backend, harness: producer?.harness ?? '', model: producer?.model ?? '' }, createdAt: now,
      })
      prune(store, { maxEntries: CACHE_MAX_ENTRIES, maxAgeMs: CACHE_MAX_AGE_MS })
    } else if (r.failure.class !== 'cancelled') {
      publish(store, key, gen, { v: SCHEMA_VERSION, state: 'failed', key, failureClass: r.failure.class, createdAt: now })
    }
    return r
  } finally {
    releaseLock(store, key, gen)
  }
}

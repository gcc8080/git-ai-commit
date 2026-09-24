// 把"生成一条消息"串起来：解析 profile → 构造模型输入 → 能力探测 → 生成（含一次纠正）→ 必要时回退一次。
// 能力三态（D7）：不兼容永不调用；未验证默认调用并在诊断中注明，严格模式拒绝；两者都不触发回退。
// 回退（D8）：只用本机配置的回退链，默认关闭；一次生成至多切换一次，按失败类别决定；与首选后端共用同一个总预算（D17）。
import { resolveProfile } from '../config/profile.ts'
import type { MachineConfig, Profile } from '../config/machine.ts'
import type { Snapshot } from '../git/snapshot.ts'
import { probeCapability } from '../backend/capability.ts'
import { FALLBACK_ELIGIBLE } from '../backend/classify.ts'
import { createBackend } from '../backend/registry.ts'
import type { Failure } from '../backend/types.ts'
import { buildModelInput, type ModelInput } from '../input/build.ts'
import { generateWith, type GenResult } from '../generate.ts'
import type { Context } from './context.ts'

/** 配置了回退链时，为回退保留的总预算比例：首选后端卡住时，回退仍有时间完成。 */
export const FALLBACK_RESERVE = 0.4

export interface FlowOptions {
  profileFlag?: string | undefined
  signal: AbortSignal
  onStart?: (profileName: string) => void
  /** 需要让用户看到的一行诊断：未验证的后端版本、发生回退等。 */
  onNotice?: (message: string) => void
  /** 同一快照正在由其他任务生成、前台开始等待时调用。 */
  onWait?: () => void
  /** 后端主进程启动后调用：pid 即它的进程组 id（后台任务据此登记，供接管与卸载终止）。 */
  onBackendSpawn?: (pid: number, profile: Profile) => void
}

export type FlowResult = (GenResult & { fallbackFrom?: string; fromCache?: boolean }) | { ok: false; failure: Failure; backend: null }

/** 已解析的主 profile；模型输入按需构造（缓存命中时不需要逐文件取差异）。 */
export interface Prepared {
  profile: Profile
  snapshot: Snapshot
  input: () => ModelInput
}

export function prepare(ctx: Context, snapshot: Snapshot, profileFlag: string | undefined): { ok: true; prepared: Prepared } | { ok: false; failure: Failure } {
  const picked = resolveProfile({ flag: profileFlag, env: ctx.env, git: ctx.git, machine: ctx.machine.config })
  if (!picked.ok) return { ok: false, failure: { class: 'config', message: picked.error } }
  let built: ModelInput | null = null
  const input = () => (built ??= buildModelInput(ctx.git, snapshot, ctx.rules))
  return { ok: true, prepared: { profile: picked.profile, snapshot, input } }
}

/** 回退链中第一个不同于首选的 profile。 */
export function pickFallback(config: MachineConfig, primary: string): Profile | null {
  for (const name of config.fallback) {
    if (name === primary) continue
    const p = config.profiles.get(name)
    if (p) return p
  }
  return null
}

async function attempt(ctx: Context, profile: Profile, input: ModelInput, deadline: number, opts: FlowOptions): Promise<GenResult> {
  const cap = await probeCapability(profile, ctx.env, { deadline })
  if (cap.state === 'incompatible') {
    if (cap.executable === null) return { ok: false, failure: { class: 'config', message: `${profile.name}：${cap.reasons.join('；')}` }, backend: profile.name }
    const label = cap.version ? `${profile.harness} ${cap.version}` : profile.harness
    const why = cap.missing.length > 0 ? `缺少必需的限制参数：${cap.missing.join(', ')}` : cap.reasons.join('；')
    return { ok: false, failure: { class: 'incompatible', message: `${profile.name}：${label} 不兼容（${why}），不调用` }, backend: profile.name }
  }
  if (cap.state === 'unverified') {
    const label = `${profile.harness} ${cap.version ?? '（版本未知）'}`
    if (ctx.machine.config.strict) {
      return { ok: false, failure: { class: 'incompatible', message: `${profile.name}：${label} 为未验证状态，严格模式下拒绝调用` }, backend: profile.name }
    }
    opts.onNotice?.(`${profile.name}：${label} 为未验证状态，照常调用（详情见 git ai-commit doctor）`)
  }
  opts.onStart?.(profile.name)
  const onSpawn = opts.onBackendSpawn ? (pid: number) => opts.onBackendSpawn!(pid, profile) : undefined
  return generateWith(createBackend(profile, ctx.env), input, { rules: ctx.rules, deadline, signal: opts.signal, ...(onSpawn ? { onSpawn } : {}) })
}

/** 从已备好的输入生成：首选后端（含一次纠正），必要时回退一次。deadline 是调用方的总截止时间（performance.now 基准）。 */
export async function generateFrom(ctx: Context, prepared: Prepared, deadline: number, opts: FlowOptions): Promise<GenResult & { fallbackFrom?: string }> {
  const { profile } = prepared
  const input = prepared.input()
  const fallback = pickFallback(ctx.machine.config, profile.name)
  const now = performance.now()
  const first = await attempt(ctx, profile, input, fallback ? now + (deadline - now) * (1 - FALLBACK_RESERVE) : deadline, opts)
  if (first.ok || fallback === null || opts.signal.aborted || !FALLBACK_ELIGIBLE.has(first.failure.class)) return first
  opts.onNotice?.(`${first.failure.message}；改用回退后端 ${fallback.name}`)
  const second = await attempt(ctx, fallback, input, deadline, opts)
  if (second.ok) opts.onNotice?.(`本次提交信息由回退后端 ${fallback.name} 生成（首选 ${profile.name} 失败）`)
  return { ...second, fallbackFrom: profile.name }
}

export async function runGeneration(ctx: Context, snapshot: Snapshot, opts: FlowOptions): Promise<FlowResult> {
  const deadline = performance.now() + ctx.machine.config.timeoutMs
  const prep = prepare(ctx, snapshot, opts.profileFlag)
  if (!prep.ok) return { ok: false, failure: prep.failure, backend: null }
  return generateFrom(ctx, prep.prepared, deadline, opts)
}

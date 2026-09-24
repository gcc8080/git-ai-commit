// profile 选择优先级：--profile → AI_COMMIT_PROFILE → git config --local aicommit.profile → 本机默认。
import type { Git } from '../git/git.ts'
import type { MachineConfig, Profile } from './machine.ts'

export type ProfileSource = 'flag' | 'env' | 'git' | 'default'

export interface ProfileSources {
  flag?: string | undefined
  env?: string | undefined
  gitLocal?: string | undefined
  machineDefault?: string | null | undefined
}

export function resolveProfileName(src: ProfileSources): { name: string; source: ProfileSource } | null {
  const pick = (v: string | null | undefined) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)
  const flag = pick(src.flag)
  if (flag) return { name: flag, source: 'flag' }
  const env = pick(src.env)
  if (env) return { name: env, source: 'env' }
  const git = pick(src.gitLocal)
  if (git) return { name: git, source: 'git' }
  const def = pick(src.machineDefault)
  if (def) return { name: def, source: 'default' }
  return null
}


export type ResolvedProfile =
  | { ok: true; profile: Profile; source: ProfileSource }
  | { ok: false; error: string }

/** 读取各级来源并解析出本次使用的 profile；只读，不修改任何配置。 */
export function resolveProfile(opts: { flag?: string | undefined; env: NodeJS.ProcessEnv; git: Git | null; machine: MachineConfig }): ResolvedProfile {
  const gitLocal = opts.git?.configGet('aicommit.profile', 'local') ?? undefined
  const picked = resolveProfileName({
    flag: opts.flag,
    env: opts.env.AI_COMMIT_PROFILE,
    gitLocal,
    machineDefault: opts.machine.defaultProfile,
  })
  if (picked === null) {
    return { ok: false, error: '未配置 profile：请在本机配置中设置 defaultProfile，或用 AI_COMMIT_PROFILE 指定' }
  }
  const profile = opts.machine.profiles.get(picked.name)
  if (profile === undefined) {
    const from = { flag: '--profile', env: 'AI_COMMIT_PROFILE', git: 'git config aicommit.profile', default: 'defaultProfile' }[picked.source]
    return { ok: false, error: `profile "${picked.name}"（来自 ${from}）不存在于本机配置中` }
  }
  return { ok: true, profile, source: picked.source }
}

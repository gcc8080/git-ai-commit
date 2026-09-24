// 本机配置：$XDG_CONFIG_HOME/git-ai-commit/config.json（默认 ~/.config/git-ai-commit/config.json）。
// profile 的 harness、provider、model、effort 是四个独立字段；effort 通过各后端自己的参数传递，不拼进模型标识。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { ParseResult } from './repo.ts'

export const HARNESSES = ['claude', 'codex', 'opencode', 'pi'] as const
export type Harness = (typeof HARNESSES)[number]

export interface Profile {
  name: string
  harness: Harness
  model: string
  provider: string | null
  effort: string | null
  /** 后端可执行文件的绝对路径；为空时从 PATH 查找同名命令。 */
  executable: string | null
}

export interface MachineConfig {
  profiles: Map<string, Profile>
  defaultProfile: string | null
  /** 回退链（有序）；一次生成至多切换一次，只使用第一个可用项。默认为空，即不回退。 */
  fallback: string[]
  /** 严格模式：拒绝调用"未验证"的后端版本。 */
  strict: boolean
  /** 前台总时间预算。 */
  timeoutMs: number
  /** 预热去抖窗口。 */
  debounceMs: number
}

export const DEFAULT_TIMEOUT_MS = 45_000
export const DEFAULT_DEBOUNCE_MS = 1_500

export function emptyMachineConfig(): MachineConfig {
  return { profiles: new Map(), defaultProfile: null, fallback: [], strict: false, timeoutMs: DEFAULT_TIMEOUT_MS, debounceMs: DEFAULT_DEBOUNCE_MS }
}

export function machineConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(env.HOME ?? homedir(), '.config')
  return join(base, 'git-ai-commit', 'config.json')
}

const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && !/[\u0000-\u001f]/.test(v)

function parseProfile(name: string, raw: unknown, diags: string[]): Profile | null {
  const where = `profile "${name}"`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    diags.push(`${where} 必须是对象`)
    return null
  }
  const r = raw as Record<string, unknown>
  const harness = r.harness
  if (!isNonEmpty(harness)) {
    diags.push(`${where} 缺少必填字段 harness（${HARNESSES.join(' | ')}）`)
    return null
  }
  if (!(HARNESSES as readonly string[]).includes(harness)) {
    diags.push(`${where} 的 harness "${harness}" 不受支持（${HARNESSES.join(' | ')}）`)
    return null
  }
  if (!isNonEmpty(r.model)) {
    diags.push(`${where} 缺少必填字段 model（需明确指定模型标识，不做模糊匹配）`)
    return null
  }
  const provider = r.provider === undefined || r.provider === null ? null : r.provider
  if (provider !== null && !isNonEmpty(provider)) {
    diags.push(`${where} 的 provider 必须是非空字符串`)
    return null
  }
  const effort = r.effort === undefined || r.effort === null ? null : r.effort
  if (effort !== null && !isNonEmpty(effort)) {
    diags.push(`${where} 的 effort 必须是非空字符串`)
    return null
  }
  const executable = r.executable === undefined || r.executable === null ? null : r.executable
  if (executable !== null && !(isNonEmpty(executable) && isAbsolute(executable))) {
    diags.push(`${where} 的 executable 必须是绝对路径`)
    return null
  }
  const h = harness as Harness
  if (h === 'pi' && provider === null) {
    diags.push(`${where}：pi 必须显式指定 provider`)
    return null
  }
  if ((h === 'claude' || h === 'opencode') && provider !== null) {
    diags.push(h === 'claude'
      ? `${where}：claude 不使用 provider 字段`
      : `${where}：opencode 的供应商写在 model 中（provider/model），不使用 provider 字段`)
    return null
  }
  if (h === 'opencode' && !(r.model as string).includes('/')) {
    diags.push(`${where}：opencode 的 model 必须是 provider/model 形式`)
    return null
  }
  for (const k of Object.keys(r)) {
    if (!['harness', 'model', 'provider', 'effort', 'executable'].includes(k)) diags.push(`${where}：未知字段 "${k}"，已忽略`)
  }
  return { name, harness: h, model: r.model as string, provider, effort, executable }
}

export function parseMachineConfig(text: string): ParseResult<MachineConfig> {
  const diagnostics: string[] = []
  const cfg = emptyMachineConfig()
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { value: cfg, diagnostics: [`本机配置不是合法的 JSON：${(err as Error).message}`] }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { value: cfg, diagnostics: ['本机配置顶层必须是对象'] }
  }
  const r = raw as Record<string, unknown>
  if (r.profiles !== undefined) {
    if (typeof r.profiles !== 'object' || r.profiles === null || Array.isArray(r.profiles)) {
      diagnostics.push('profiles 必须是对象')
    } else {
      for (const [name, p] of Object.entries(r.profiles)) {
        const prof = parseProfile(name, p, diagnostics)
        if (prof) cfg.profiles.set(name, prof)
      }
    }
  }
  if (r.defaultProfile !== undefined && r.defaultProfile !== null) {
    if (!isNonEmpty(r.defaultProfile)) diagnostics.push('defaultProfile 必须是字符串')
    else if (!cfg.profiles.has(r.defaultProfile)) diagnostics.push(`defaultProfile "${r.defaultProfile}" 不存在于 profiles 中`)
    else cfg.defaultProfile = r.defaultProfile
  }
  if (r.fallback !== undefined) {
    if (!Array.isArray(r.fallback) || !r.fallback.every(isNonEmpty)) {
      diagnostics.push('fallback 必须是 profile 名称数组')
    } else {
      for (const name of r.fallback as string[]) {
        if (cfg.profiles.has(name)) cfg.fallback.push(name)
        else diagnostics.push(`fallback 中的 "${name}" 不存在于 profiles 中，已忽略`)
      }
    }
  }
  if (r.strict !== undefined) {
    if (typeof r.strict !== 'boolean') diagnostics.push('strict 必须是布尔值')
    else cfg.strict = r.strict
  }
  if (r.timeoutMs !== undefined) {
    if (!(typeof r.timeoutMs === 'number' && Number.isInteger(r.timeoutMs) && r.timeoutMs > 0)) diagnostics.push('timeoutMs 必须是正整数')
    else cfg.timeoutMs = r.timeoutMs
  }
  if (r.debounceMs !== undefined) {
    if (!(typeof r.debounceMs === 'number' && Number.isInteger(r.debounceMs) && r.debounceMs >= 0)) diagnostics.push('debounceMs 必须是非负整数')
    else cfg.debounceMs = r.debounceMs
  }
  for (const k of Object.keys(r)) {
    if (!['profiles', 'defaultProfile', 'fallback', 'strict', 'timeoutMs', 'debounceMs'].includes(k)) diagnostics.push(`本机配置：未知字段 "${k}"，已忽略`)
  }
  return { value: cfg, diagnostics }
}

export interface LoadedMachineConfig {
  path: string
  exists: boolean
  config: MachineConfig
  diagnostics: string[]
}

export function loadMachineConfig(env: NodeJS.ProcessEnv = process.env): LoadedMachineConfig {
  const path = machineConfigPath(env)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { path, exists: false, config: emptyMachineConfig(), diagnostics: [] }
  }
  const { value, diagnostics } = parseMachineConfig(text)
  return { path, exists: true, config: value, diagnostics }
}

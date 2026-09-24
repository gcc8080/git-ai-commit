// 能力探测与兼容性三态（D7）：
// - 必需的限制参数必须出现在帮助文本中；codex 另用 --strict-config 核对传入的 -c 配置键仍被识别
//   （在空的 CODEX_HOME 中探测，只校验本工具的覆盖项，不受用户 config.toml 影响，也不会调用模型）；
// - 兼容：版本在合同测试基线内，且该后端在能力矩阵中没有"待核实"项；
// - 未验证：不满足"兼容"，但必需参数齐全——默认调用并在诊断中注明，严格模式拒绝；
// - 不兼容：缺少任一必需参数——永不调用。
// "参数存在"最多只能让版本从不兼容变为未验证，不能变为兼容。
// 探测结果按可执行文件的身份（真实路径、大小、修改时间）缓存在本机缓存目录中，CLI 自动更新后自动重新探测。
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { Harness, Profile } from '../config/machine.ts'
import { resolveExecutable } from '../util/which.ts'
import { execBackend } from './exec.ts'
import { CODEX_CONFIG_OVERRIDES } from './codex.ts'

export type CompatState = 'compatible' | 'unverified' | 'incompatible'

export interface Capability {
  state: CompatState
  /** 解析出的可执行文件；找不到时为 null（此时 state 为 incompatible）。 */
  executable: string | null
  version: string | null
  /** 缺少的必需参数或配置键。 */
  missing: string[]
  /** 版本不在基线内，或能力矩阵中还有待核实项时的说明。 */
  reasons: string[]
}

interface HelpSpec {
  /** 读取帮助文本的参数。 */
  helpArgs: string[]
  /** 总是必需的限制参数。 */
  flags: string[]
  /** 仅在 profile 设置了 effort 时必需的参数。 */
  effortFlag: string
}

export const HELP_SPEC: Record<Harness, HelpSpec> = {
  claude: {
    helpArgs: ['--help'],
    flags: ['--print', '--safe-mode', '--tools', '--strict-mcp-config', '--no-session-persistence', '--output-format', '--model'],
    effortFlag: '--effort',
  },
  codex: {
    helpArgs: ['exec', '--help'],
    flags: ['--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--color', '--sandbox', '--config', '--output-schema', '--output-last-message', '--model', '--strict-config'],
    effortFlag: '--config',
  },
  pi: {
    helpArgs: ['--help'],
    flags: ['--print', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-session', '--no-approve', '--provider', '--model', '--mode', '--list-models'],
    effortFlag: '--thinking',
  },
  opencode: {
    helpArgs: ['run', '--help'],
    flags: ['--pure', '--format', '--agent', '--title', '--model'],
    effortFlag: '--variant',
  },
}

/**
 * 合同测试基线（D7）：跑过完整能力矩阵合同测试（test/contract/capability-matrix.test.ts）的版本，
 * 以及能力矩阵中尚待核实的项。升级基线前须在新版本上重跑该合同测试。
 */
export const BASELINE: Record<Harness, { versions: string[]; pending: string[] }> = {
  claude: { versions: ['2.1.281'], pending: [] },
  codex: { versions: ['0.156.1'], pending: [] },
  pi: { versions: ['0.87.1'], pending: [] },
  opencode: { versions: ['1.18.32'], pending: [] },
}

/** 缓存格式版本：必需参数清单变化时使旧缓存失效。 */
const CACHE_FORMAT = JSON.stringify([2, HELP_SPEC, CODEX_CONFIG_OVERRIDES])

export interface Probe {
  version: string | null
  /** 帮助文本中出现的已知参数。 */
  flags: string[]
  /** codex：未被识别的配置键。 */
  unknownKeys: string[]
}

interface CacheEntry extends Probe {
  format: string
  size: number
  mtimeMs: number
}

/** 本机缓存目录：$XDG_CACHE_HOME/git-ai-commit（默认 ~/.cache/git-ai-commit）。 */
export function cacheDir(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(env.HOME ?? homedir(), '.cache')
  return join(base, 'git-ai-commit')
}

export function cacheFile(env: NodeJS.ProcessEnv): string {
  return join(cacheDir(env), 'capabilities.json')
}

function readCache(file: string): Record<string, CacheEntry> {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, CacheEntry>) : {}
  } catch {
    return {}
  }
}

function writeCache(file: string, key: string, entry: CacheEntry): void {
  try {
    const all = readCache(file)
    all[key] = entry
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    // 缓存只是加速手段，写不进去不影响结果
  }
}

export function hasFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[\\s,\\[(])${escaped}(?=[\\s,=\\]<)]|$)`, 'm').test(help)
}

export function parseVersion(out: string): string | null {
  return /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(out)?.[1] ?? null
}

/** codex --strict-config 的报错中列出的未识别配置键（包括值不合法的键）。 */
export function parseUnknownKeys(stderr: string): string[] {
  const keys = new Set<string>()
  for (const m of stderr.matchAll(/unknown configuration field `([^`]+)`/g)) keys.add(m[1]!)
  for (const m of stderr.matchAll(/unknown variant `[^`]*`.*? in `([^`]+)`/g)) keys.add(m[1]!)
  return [...keys]
}

async function probe(harness: Harness, executable: string, env: NodeJS.ProcessEnv, deadline: number): Promise<Probe | null> {
  const spec = HELP_SPEC[harness]
  const run = (args: string[], extraEnv?: Record<string, string>) =>
    execBackend({ command: executable, args, stdin: '', deadline, env, ...(extraEnv ? { extraEnv } : {}) })
  const [ver, help, strict] = await Promise.all([
    run(['--version']),
    run(spec.helpArgs),
    harness === 'codex'
      ? run(['exec', '--strict-config', ...CODEX_CONFIG_OVERRIDES.flatMap((c) => ['-c', c]), '--ephemeral', '--skip-git-repo-check', '--color', 'never', '-'], { CODEX_HOME: '{tmp}' })
      : Promise.resolve(null),
  ])
  const helpText = `${help.stdout}\n${help.stderr}`
  // 帮助文本读不到时不下结论，也不缓存
  if (help.spawnError !== null || help.timedOut || help.cancelled || help.status !== 0 || helpText.trim() === '') return null
  const known = [...new Set([...spec.flags, spec.effortFlag])]
  const unknownKeys = strict === null ? [] : parseUnknownKeys(strict.stderr)
  return {
    version: ver.status === 0 ? parseVersion(ver.stdout) : null,
    flags: known.filter((f) => hasFlag(helpText, f)),
    unknownKeys,
  }
}

export function evaluate(profile: Profile, executable: string, p: Probe, base: { versions: string[]; pending: string[] } = BASELINE[profile.harness]): Capability {
  const spec = HELP_SPEC[profile.harness]
  const required = [...spec.flags, ...(profile.effort !== null ? [spec.effortFlag] : [])]
  const missing = [...required.filter((f) => !p.flags.includes(f)), ...p.unknownKeys.map((k) => `配置键 ${k}`)]
  if (missing.length > 0) return { state: 'incompatible', executable, version: p.version, missing, reasons: [] }
  const reasons: string[] = []
  if (p.version === null || !base.versions.includes(p.version)) {
    reasons.push(`版本 ${p.version ?? '未知'} 不在合同测试基线内（${base.versions.join('、')}）`)
  }
  if (base.pending.length > 0) reasons.push(`能力矩阵中待核实：${base.pending.join('；')}`)
  return { state: reasons.length === 0 ? 'compatible' : 'unverified', executable, version: p.version, missing: [], reasons }
}

export interface ProbeOptions {
  deadline: number
  /** 忽略缓存重新探测（doctor 使用）。 */
  fresh?: boolean
}

export async function probeCapability(profile: Profile, env: NodeJS.ProcessEnv, opts: ProbeOptions): Promise<Capability> {
  const command = profile.executable ?? profile.harness
  const found = resolveExecutable(command, env)
  if (found === null) return { state: 'incompatible', executable: null, version: null, missing: [], reasons: [`找不到可执行文件 ${command}`] }
  let real: string
  let size: number
  let mtimeMs: number
  try {
    real = realpathSync(found)
    const st = statSync(real)
    size = st.size
    mtimeMs = st.mtimeMs
  } catch {
    return { state: 'incompatible', executable: null, version: null, missing: [], reasons: [`无法读取可执行文件 ${found}`] }
  }
  const file = cacheFile(env)
  const key = `${profile.harness}\0${real}`
  const cached = opts.fresh ? undefined : readCache(file)[key]
  if (cached && cached.format === CACHE_FORMAT && cached.size === size && cached.mtimeMs === mtimeMs) {
    return evaluate(profile, found, cached)
  }
  const p = await probe(profile.harness, found, env, Math.min(opts.deadline, performance.now() + 15_000))
  if (p === null) {
    return { state: 'incompatible', executable: found, version: null, missing: HELP_SPEC[profile.harness].flags, reasons: ['无法读取帮助文本'] }
  }
  writeCache(file, key, { ...p, format: CACHE_FORMAT, size, mtimeMs })
  return evaluate(profile, found, p)
}

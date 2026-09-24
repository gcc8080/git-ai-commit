// 生成规则：默认值 + 仓库共享配置（.ai-commit.json）覆盖。
export type LengthUnit = 'codepoint' | 'utf16'

export interface Rules {
  language: string
  format: 'conventional'
  headerMaxWidth: number
  headerMaxLength: number
  lengthUnit: LengthUnit
  /** prompt 中的软目标（显示宽度），不参与校验。 */
  softHeaderWidth: number
  types: string[]
  /** 路径模式 → scope 名称，作为提示提供给模型。 */
  scopeRules: Record<string, string>
  maxInputBytes: number
  maxPerFileBytes: number
  bodyMaxItems: number
  bodyMaxItemLength: number
  /** 秘密排除清单：匹配的文件只报告变化事实，不提供内容。 */
  exclude: string[]
  /** 预算降噪清单：锁文件、生成物等只给统计。 */
  statOnly: string[]
}

export const DEFAULT_TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert']

export const DEFAULT_EXCLUDE = [
  '.env', '.env.*', '*.env',
  '*.pem', '*.key', '*.p8', '*.p12', '*.pfx', '*.crt', '*.cer',
  '*.keystore', '*.jks', '*.bks',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  '.netrc',
]

export const DEFAULT_STAT_ONLY = [
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'poetry.lock', 'Pipfile.lock', 'go.sum',
  'Podfile.lock', 'pubspec.lock', 'gradle.lockfile', 'flake.lock', 'mix.lock', 'packages.lock.json',
  '*.min.js', '*.min.css', '*.map', '*.g.dart', '*.freezed.dart', '*.pb.go', '*_pb2.py',
]

export const DEFAULT_RULES: Rules = {
  language: 'zh-CN',
  format: 'conventional',
  headerMaxWidth: 72,
  headerMaxLength: 72,
  lengthUnit: 'codepoint',
  softHeaderWidth: 50,
  types: DEFAULT_TYPES,
  scopeRules: {},
  maxInputBytes: 96_000,
  maxPerFileBytes: 16_000,
  bodyMaxItems: 8,
  bodyMaxItemLength: 200,
  exclude: DEFAULT_EXCLUDE,
  statOnly: DEFAULT_STAT_ONLY,
}

export interface RepoRules {
  language?: string
  format?: 'conventional'
  headerMaxWidth?: number
  headerMaxLength?: number
  lengthUnit?: LengthUnit
  types?: string[]
  scopeRules?: Record<string, string>
  maxInputBytes?: number
  maxPerFileBytes?: number
  bodyMaxItems?: number
  bodyMaxItemLength?: number
  /** 追加到默认秘密排除清单（不能删除默认项）。 */
  exclude?: string[]
  /** 追加到默认降噪清单。 */
  statOnly?: string[]
}

export function effectiveRules(repo: RepoRules = {}): Rules {
  const { exclude, statOnly, ...rest } = repo
  const merged: Rules = { ...DEFAULT_RULES }
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) (merged as unknown as Record<string, unknown>)[k] = v
  }
  merged.exclude = [...DEFAULT_EXCLUDE, ...(exclude ?? [])]
  merged.statOnly = [...DEFAULT_STAT_ONLY, ...(statOnly ?? [])]
  return merged
}

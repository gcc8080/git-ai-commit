// 仓库共享配置 .ai-commit.json：只接受提交规范字段。
// 凭证、可执行命令、回退链、预热开关、后端选择一律拒绝该项并给出诊断；未知字段忽略并给出诊断。
import type { LengthUnit, RepoRules } from './rules.ts'

export const REPO_CONFIG_FILE = '.ai-commit.json'

export interface ParseResult<T> {
  value: T
  diagnostics: string[]
}

type Check = (v: unknown) => boolean

const isPosInt: Check = (v) => typeof v === 'number' && Number.isInteger(v) && v > 0
const isNonEmptyString: Check = (v) => typeof v === 'string' && v.trim() !== '' && !/[\u0000-\u001f]/.test(v)
const isStringArray: Check = (v) => Array.isArray(v) && v.every(isNonEmptyString)

const FIELDS: Record<keyof RepoRules, { check: Check; hint: string }> = {
  language: { check: isNonEmptyString, hint: '非空字符串，例如 "zh-CN"' },
  format: { check: (v) => v === 'conventional', hint: '第一版只支持 "conventional"' },
  headerMaxWidth: { check: isPosInt, hint: '正整数' },
  headerMaxLength: { check: isPosInt, hint: '正整数' },
  lengthUnit: { check: (v) => v === 'codepoint' || v === 'utf16', hint: '"codepoint" 或 "utf16"' },
  types: { check: (v) => isStringArray(v) && (v as string[]).length > 0 && (v as string[]).every((t) => /^[a-z][a-z0-9-]*$/.test(t)), hint: '非空的小写 type 名称数组' },
  scopeRules: {
    check: (v) => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.entries(v).every(([k, s]) => isNonEmptyString(k) && isNonEmptyString(s)),
    hint: '路径模式到 scope 名称的对象',
  },
  maxInputBytes: { check: isPosInt, hint: '正整数' },
  maxPerFileBytes: { check: isPosInt, hint: '正整数' },
  bodyMaxItems: { check: isPosInt, hint: '正整数' },
  bodyMaxItemLength: { check: isPosInt, hint: '正整数' },
  exclude: { check: isStringArray, hint: '路径模式数组' },
  statOnly: { check: isStringArray, hint: '路径模式数组' },
}

const CREDENTIAL_WORDS = new Set(['token', 'tokens', 'secret', 'secrets', 'password', 'passwd', 'credential', 'credentials', 'auth', 'apikey', 'bearer', 'cookie'])

/** 把键名拆成小写词（支持 camelCase、kebab-case、snake_case），判断是否像凭证。 */
export function looksLikeCredentialKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean)
  if (words.some((w) => CREDENTIAL_WORDS.has(w))) return true
  return words.join('').includes('apikey')
}

function containsCredentialKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredentialKey)
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(([k, v]) => looksLikeCredentialKey(k) || containsCredentialKey(v))
  }
  return false
}

function rejectionReason(key: string, value: unknown): string | null {
  if (/^prewarm/i.test(key)) return '预热开关只能由用户在本机开启（git config aicommit.prewarm），仓库共享配置无权开启'
  if (/^fallback/i.test(key)) return '回退链只能在本机配置中定义'
  if (/^(command|commands|cmd|exec|executable|script|scripts|shell|run|hook|hooks)$/i.test(key)) return '仓库共享配置不能定义可执行命令'
  if (/^(profile|profiles|default-?profile|harness|model|provider|effort)$/i.test(key)) return '后端、模型与 profile 的选择属于本机配置'
  if (looksLikeCredentialKey(key) || containsCredentialKey(value)) return '仓库共享配置不能携带凭证'
  return null
}

export function parseRepoConfig(text: string): ParseResult<RepoRules> {
  const diagnostics: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { value: {}, diagnostics: [`${REPO_CONFIG_FILE} 不是合法的 JSON，已忽略：${(err as Error).message}`] }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { value: {}, diagnostics: [`${REPO_CONFIG_FILE} 顶层必须是对象，已忽略`] }
  }
  const value: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(raw)) {
    const reason = rejectionReason(key, v)
    if (reason !== null) {
      diagnostics.push(`${REPO_CONFIG_FILE}：拒绝字段 "${key}"——${reason}`)
      continue
    }
    const field = FIELDS[key as keyof RepoRules]
    if (field === undefined) {
      diagnostics.push(`${REPO_CONFIG_FILE}：未知字段 "${key}"，已忽略`)
      continue
    }
    if (!field.check(v)) {
      diagnostics.push(`${REPO_CONFIG_FILE}：字段 "${key}" 的值无效（应为${field.hint}），已使用默认值`)
      continue
    }
    value[key] = v
  }
  return { value: value as RepoRules, diagnostics }
}

export type { LengthUnit }

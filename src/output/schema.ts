// 输出协议（D6）：候选 {type, scope, subject, body[], breakingChange} 或拒绝 {refusal}。
// 本地机械校验：禁止额外字段与控制字符、type 枚举、单行约束、body 条数与长度、尾注格式行、
// 输入中不存在的 issue 编号、配置语言的文字系统、完整 header 的显示宽度与字符串长度（D9）。
import type { LengthUnit, Rules } from '../config/rules.ts'
import { displayWidth } from '../util/eaw.ts'
import { languageName, requiredScript } from '../config/language.ts'

/** 输出协议版本：候选字段或校验规则变化时加一（缓存键与缓存条目都记录它）。 */
export const SCHEMA_VERSION = 1

export interface Candidate {
  type: string
  scope: string | null
  subject: string
  body: string[]
  breakingChange: string | null
}

export type Parsed = { kind: 'candidate'; candidate: Candidate } | { kind: 'refusal'; reason: string }

export type Validation = { ok: true; value: Parsed } | { ok: false; errors: string[] }

export interface ValidationContext {
  rules: Rules
  /**
   * 模型输入的数据区全文：候选中引用的 issue 编号必须在其中出现过。
   * 为 null 时跳过这一项：读取缓存条目时手里没有原始输入，而同一个 key 的输入在生成时已经校验过。
   */
  inputText: string | null
}

const CANDIDATE_KEYS = ['type', 'scope', 'subject', 'body', 'breakingChange']
const CONTROL = /[\u0000-\u001f\u007f]/
const TRAILER_LINE = /^\s*(?:(?:[A-Za-z0-9]+-)+[A-Za-z0-9]+|Cc|Fixes|Closes|Resolves|Refs|BREAKING[ -]CHANGE)\s*:/i
/** 形式上像工单编号、实际是常见技术名词的前缀（UTF-8、SHA-256 等），不视为 issue 编号。 */
const NOT_ISSUE_PREFIX = new Set(['UTF', 'UCS', 'SHA', 'MD', 'ISO', 'AES', 'RSA', 'DES', 'ECDSA', 'HMAC', 'HTTP', 'HTTPS', 'TLS', 'SSL', 'IPV', 'ES', 'ECMA', 'RFC', 'CVE', 'CWE', 'X', 'H', 'P', 'WIN', 'IE', 'GPT', 'PEP', 'JSR', 'ASCII', 'CSS', 'HTML', 'IEEE', 'ANSI', 'POSIX', 'GB', 'CP', 'EUC', 'LATIN', 'BASE', 'INT', 'UINT', 'FLOAT', 'VP', 'AV', 'MPEG', 'HEVC', 'JPEG'])

export function headerOf(c: Candidate): string {
  return `${c.type}${c.scope ? `(${c.scope})` : ''}${c.breakingChange ? '!' : ''}: ${c.subject}`
}

export function stringLength(s: string, unit: LengthUnit): number {
  return unit === 'utf16' ? s.length : [...s].length
}

export function issueRefs(text: string): string[] {
  const refs = new Set<string>()
  for (const m of text.matchAll(/(?<![\w&/])#(\d+)\b/g)) refs.add(m[0])
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]{0,9})-(\d+)\b/g)) {
    if (!NOT_ISSUE_PREFIX.has(m[1]!)) refs.add(m[0])
  }
  return [...refs]
}

function isSingleLine(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '' && !CONTROL.test(v)
}

export function validateOutput(raw: unknown, ctx: ValidationContext): Validation {
  const { rules, inputText } = ctx
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, errors: ['输出必须是一个 JSON 对象'] }
  const obj = raw as Record<string, unknown>

  const refusal = obj.refusal
  if (refusal !== undefined && refusal !== null) {
    if (!isSingleLine(refusal)) return { ok: false, errors: ['refusal 必须是非空的单行字符串'] }
    const others = Object.entries(obj).filter(([k, v]) => k !== 'refusal' && v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))
    if (others.length > 0) return { ok: false, errors: ['拒绝结果不能同时包含候选字段'] }
    return { ok: true, value: { kind: 'refusal', reason: refusal.trim() } }
  }

  const errors: string[] = []
  const extra = Object.keys(obj).filter((k) => !CANDIDATE_KEYS.includes(k) && k !== 'refusal')
  if (extra.length > 0) errors.push(`不允许的额外字段：${extra.join(', ')}`)

  const type = obj.type
  if (typeof type !== 'string' || !rules.types.includes(type)) errors.push(`type 必须是以下之一：${rules.types.join(', ')}`)

  let scope: string | null = null
  if (obj.scope !== null && obj.scope !== undefined && obj.scope !== '') {
    if (typeof obj.scope !== 'string' || CONTROL.test(obj.scope) || !/^[^\s()!:]+$/u.test(obj.scope)) errors.push('scope 必须为空或不含空白、括号、冒号的单个词')
    else scope = obj.scope
  }

  const subject = obj.subject
  if (!isSingleLine(subject)) errors.push('subject 必须是非空的单行字符串')

  let body: string[] = []
  if (obj.body !== undefined && obj.body !== null) {
    if (!Array.isArray(obj.body)) {
      errors.push('body 必须是字符串数组')
    } else {
      body = obj.body as string[]
      if (body.length > rules.bodyMaxItems) errors.push(`body 最多 ${rules.bodyMaxItems} 条，实际 ${body.length} 条`)
      body.forEach((item, i) => {
        if (!isSingleLine(item)) errors.push(`body[${i}] 必须是非空的单行字符串`)
        else {
          if ([...item].length > rules.bodyMaxItemLength) errors.push(`body[${i}] 超过 ${rules.bodyMaxItemLength} 个字符`)
          if (TRAILER_LINE.test(item)) errors.push(`body[${i}] 是尾注格式的行，不允许由模型生成`)
        }
      })
    }
  }

  let breakingChange: string | null = null
  if (obj.breakingChange !== null && obj.breakingChange !== undefined && obj.breakingChange !== '') {
    if (!isSingleLine(obj.breakingChange)) errors.push('breakingChange 必须为 null 或非空的单行字符串')
    else breakingChange = obj.breakingChange.trim()
  }

  if (errors.length > 0) return { ok: false, errors }

  const candidate: Candidate = { type: type as string, scope, subject: (subject as string).trim(), body: body.map((b) => b.trim()), breakingChange }
  const everything = [candidate.subject, ...candidate.body, candidate.breakingChange ?? ''].join('\n')
  const unknownRefs = inputText === null ? [] : issueRefs(everything).filter((r) => !inputText.includes(r))
  if (unknownRefs.length > 0) errors.push(`引用了输入中不存在的 issue 编号：${unknownRefs.join(', ')}`)

  const script = requiredScript(rules.language)
  if (script !== null) {
    const lang = languageName(rules.language)
    if (!script.test(candidate.subject)) errors.push(`subject 必须使用${lang}书写`)
    candidate.body.forEach((b, i) => { if (!script.test(b)) errors.push(`body[${i}] 必须使用${lang}书写`) })
    if (candidate.breakingChange !== null && !script.test(candidate.breakingChange)) errors.push(`breakingChange 必须使用${lang}书写`)
  }

  const header = headerOf(candidate)
  const width = displayWidth(header)
  if (width > rules.headerMaxWidth) errors.push(`标题过长：显示宽度 ${width} 列，上限 ${rules.headerMaxWidth} 列`)
  const len = stringLength(header, rules.lengthUnit)
  if (len > rules.headerMaxLength) errors.push(`标题过长：长度 ${len}，上限 ${rules.headerMaxLength}`)

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { kind: 'candidate', candidate } }
}

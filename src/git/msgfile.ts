// 消息文件的解析与写入（D2）。
// - 注释字符取 core.commentString / core.commentChar（默认 #）；取值为 auto 或无法确定时，调用方应保留原样。
// - scissors 行及其以下不视为正文。
// - 是否已有正文按白名单判断：只有空行与 Git 自动添加格式的 Signed-off-by 行可以忽略；
//   其他任何非空行（包括 `fix: …` 这类 Token: Value 形式的行）都视为用户正文。
// - 生成的消息插入到文件最前面，其后的原有内容一律保留。
import type { Git } from './git.ts'

export type CommentPrefix = { ok: true; prefix: string } | { ok: false; reason: string }

export function commentPrefix(git: Git): CommentPrefix {
  const str = git.configGet('core.commentString')
  const chr = git.configGet('core.commentChar')
  const v = str ?? chr
  if (v === null) return { ok: true, prefix: '#' }
  if (v === '' || v.toLowerCase() === 'auto' || /[\n\r]/.test(v)) return { ok: false, reason: `无法确定注释字符（core.commentChar=${JSON.stringify(v)}）` }
  return { ok: true, prefix: v }
}

export function scissorsLine(prefix: string): string {
  return `${prefix} ------------------------ >8 ------------------------`
}

const SIGN_OFF = /^Signed-off-by: .+ <[^<>]*>$/

export interface MessageAnalysis {
  hasUserContent: boolean
  /** 第一行用户正文（用于诊断）。 */
  firstContentLine: string | null
}

export function analyzeMessage(content: string, prefix: string): MessageAnalysis {
  const lines = content.split('\n')
  const scissors = scissorsLine(prefix)
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (line === scissors) break
    if (line.startsWith(prefix)) continue
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (SIGN_OFF.test(trimmed)) continue
    return { hasUserContent: true, firstContentLine: trimmed }
  }
  return { hasUserContent: false, firstContentLine: null }
}

/** 把生成的消息插到最前面，保留其后全部原有内容（签名行、注释、scissors 及以下）。 */
export function insertMessage(original: string, message: string): string {
  const msg = message.replace(/\n+$/, '')
  if (original === '') return msg + '\n'
  if (original.startsWith('\n')) return msg + '\n' + original
  return msg + '\n\n' + original
}

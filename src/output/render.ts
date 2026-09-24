// 渲染（D6）：! 与 BREAKING CHANGE: 由本工具依 breakingChange 字段生成，不由模型产出。
import { headerOf, type Candidate } from './schema.ts'

export function renderMessage(c: Candidate): string {
  const parts = [headerOf(c)]
  if (c.body.length > 0) parts.push(c.body.map((b) => `- ${b}`).join('\n'))
  if (c.breakingChange) parts.push(`BREAKING CHANGE: ${c.breakingChange}`)
  return parts.join('\n\n')
}

// 历史样本（D9）：HEAD 的 first-parent 历史中最近 20 条非 merge 提交。
// 每条只包含标题与在本地判定的"是否有正文"标记，不发送正文内容。
import type { Git } from '../git/git.ts'

export const HISTORY_COUNT = 20
export const HISTORY_MAX_BYTES = 4000

export interface HistoryEntry {
  oid: string
  subject: string
  hasBody: boolean
}

const TRAILER = /^(Signed-off-by|Co-authored-by|Reviewed-by|Acked-by|Tested-by|Reported-by|Suggested-by|Helped-by|Change-Id|Cc):/i

export function sampleHistory(git: Git, head: string | null): HistoryEntry[] {
  if (head === null) return []
  const out = git.runBuffer(['log', '--first-parent', '--no-merges', '-n', String(HISTORY_COUNT), '--format=%H%x00%s%x00%b%x1e', head]).stdout.toString('utf8')
  const entries: HistoryEntry[] = []
  let used = 0
  for (const rec of out.split('\x1e')) {
    const r = rec.replace(/^\n/, '')
    if (r === '') continue
    const [oid, subject = '', body = ''] = r.split('\0')
    if (!oid) continue
    const size = Buffer.byteLength(subject, 'utf8') + 1
    if (used + size > HISTORY_MAX_BYTES) break
    used += size
    const hasBody = body.split('\n').some((l) => l.trim() !== '' && !TRAILER.test(l.trim()))
    entries.push({ oid, subject, hasBody })
  }
  return entries
}

export interface HistoryStyle {
  total: number
  conventional: number
  withScope: number
  withBody: number
}

const CONVENTIONAL = /^[a-z][a-z0-9-]*(\([^)]*\))?!?: \S/

export function historyStyle(entries: HistoryEntry[]): HistoryStyle {
  let conventional = 0
  let withScope = 0
  let withBody = 0
  for (const e of entries) {
    const m = CONVENTIONAL.exec(e.subject)
    if (m) {
      conventional++
      if (m[1]) withScope++
    }
    if (e.hasBody) withBody++
  }
  return { total: entries.length, conventional, withScope, withBody }
}

// 输入预算与覆盖标注：按文件分配字节预算，逐文件标注覆盖状态；不截断后仍声称完整。
import type { Rules } from '../config/rules.ts'
import { matchAny } from '../util/glob.ts'
import type { Git } from '../git/git.ts'
import { blobInfo, displayPath, fetchPatch, isNullOid, type Change } from './changes.ts'

export type Coverage = 'full' | 'partial' | 'stat-only' | 'omitted' | 'binary' | 'excluded' | 'submodule' | 'lfs'

export interface FileInput {
  change: Change
  path: string
  coverage: Coverage
  /** 提供给模型的补丁文本（只有 full / partial 才非空）。 */
  patch: string
  /** partial：被省略的行数。 */
  omittedLines: number
  /** binary：新内容（删除时为旧内容）的字节数。 */
  size: number | null
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

/** 在字节上限内按行截断。 */
export function truncateAtLine(text: string, maxBytes: number): { kept: string; omittedLines: number } {
  if (bytes(text) <= maxBytes) return { kept: text, omittedLines: 0 }
  const lines = text.split('\n')
  let used = 0
  let n = 0
  for (; n < lines.length; n++) {
    const len = bytes(lines[n]!) + 1
    if (used + len > maxBytes) break
    used += len
  }
  const kept = n === 0 ? '' : lines.slice(0, n).join('\n') + '\n'
  const omittedLines = lines.slice(n).filter((l, i, arr) => !(i === arr.length - 1 && l === '')).length
  return { kept, omittedLines }
}

export function planInput(git: Git, base: string, target: string, changes: Change[], excluded: Set<Change>, rules: Rules): FileInput[] {
  const files: FileInput[] = changes.map((c) => ({ change: c, path: displayPath(c), coverage: 'full', patch: '', omittedLines: 0, size: null }))
  const candidates: FileInput[] = []
  for (const f of files) {
    const c = f.change
    if (excluded.has(c)) f.coverage = 'excluded'
    else if (c.submodule) f.coverage = 'submodule'
    else if (c.binary) f.coverage = 'binary'
    else if (matchAny(c.newPath, rules.statOnly) || matchAny(c.oldPath, rules.statOnly)) f.coverage = 'stat-only'
    else candidates.push(f)
  }

  const info = blobInfo(git, files.filter((f) => f.coverage !== 'excluded' && f.coverage !== 'submodule').flatMap((f) => [f.change.oldOid, f.change.newOid]))
  for (const f of files) {
    const oid = isNullOid(f.change.newOid) ? f.change.oldOid : f.change.newOid
    if (f.coverage === 'binary') f.size = info.get(oid)?.size ?? null
  }
  for (const f of candidates) {
    if (info.get(f.change.newOid)?.lfs || info.get(f.change.oldOid)?.lfs) f.coverage = 'lfs'
  }

  // 先放小的：按增删行数升序取补丁，直到预算用完
  const ordered = candidates
    .filter((f) => f.coverage === 'full')
    .sort((a, b) => ((a.change.added ?? 0) + (a.change.deleted ?? 0)) - ((b.change.added ?? 0) + (b.change.deleted ?? 0)))
  let remaining = rules.maxInputBytes
  for (const f of ordered) {
    if (remaining <= 0) {
      f.coverage = 'omitted'
      continue
    }
    const patch = fetchPatch(git, base, target, f.change)
    const cap = Math.min(rules.maxPerFileBytes, remaining)
    if (bytes(patch) <= cap) {
      f.patch = patch
      remaining -= bytes(patch)
      continue
    }
    const { kept, omittedLines } = truncateAtLine(patch, cap)
    if (kept === '') {
      f.coverage = 'omitted'
      continue
    }
    f.coverage = 'partial'
    f.patch = kept
    f.omittedLines = omittedLines
    remaining -= bytes(kept)
  }
  return files
}

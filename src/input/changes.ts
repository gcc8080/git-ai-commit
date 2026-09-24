// 差异采集（D12）：只用 plumbing 比较 base 与 target 两个 tree，并显式禁用外部转换；
// 固定影响覆盖范围与格式的参数，不受用户 diff.* 配置影响；文件清单按 NUL 分隔读取。
import { splitNul, type Git } from '../git/git.ts'

export const DIFF_OPTS = ['-r', '-M', '-C', '--no-textconv', '--no-ext-diff', '--no-color'] as const

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X'

export interface Change {
  status: ChangeStatus
  /** 重命名 / 复制的相似度。 */
  score: number | null
  oldPath: string | null
  newPath: string | null
  oldMode: string
  newMode: string
  oldOid: string
  newOid: string
  /** 二进制文件为 null。 */
  added: number | null
  deleted: number | null
  binary: boolean
  submodule: boolean
}

export function displayPath(c: Change): string {
  return (c.newPath ?? c.oldPath)!
}

export function isNullOid(oid: string): boolean {
  return /^0+$/.test(oid)
}

export function parseRaw(parts: string[]): Change[] {
  const out: Change[] = []
  let i = 0
  while (i < parts.length) {
    const meta = parts[i++]!
    if (meta === '') continue
    if (!meta.startsWith(':')) throw new Error(`无法解析 diff-tree --raw 输出：${JSON.stringify(meta)}`)
    const [oldMode, newMode, oldOid, newOid, statusField] = meta.slice(1).split(' ')
    if (!oldMode || !newMode || !oldOid || !newOid || !statusField) throw new Error(`无法解析 diff-tree --raw 条目：${meta}`)
    const status = statusField[0] as ChangeStatus
    const score = statusField.length > 1 ? Number(statusField.slice(1)) : null
    let oldPath: string | null
    let newPath: string | null
    if (status === 'R' || status === 'C') {
      oldPath = parts[i++]!
      newPath = parts[i++]!
    } else if (status === 'A') {
      newPath = parts[i++]!
      oldPath = null
    } else if (status === 'D') {
      oldPath = parts[i++]!
      newPath = null
    } else {
      oldPath = newPath = parts[i++]!
    }
    out.push({
      status, score, oldPath, newPath, oldMode, newMode, oldOid, newOid,
      added: null, deleted: null, binary: false,
      submodule: oldMode === '160000' || newMode === '160000',
    })
  }
  return out
}

interface NumstatEntry {
  added: number | null
  deleted: number | null
  path: string
}

export function parseNumstat(parts: string[]): NumstatEntry[] {
  const out: NumstatEntry[] = []
  let i = 0
  while (i < parts.length) {
    const head = parts[i++]!
    if (head === '') continue
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(head)
    if (!m) throw new Error(`无法解析 diff-tree --numstat 条目：${JSON.stringify(head)}`)
    let path = m[3]!
    if (path === '') {
      i++ // 重命名 / 复制：先是旧路径
      path = parts[i++]!
    }
    out.push({ added: m[1] === '-' ? null : Number(m[1]), deleted: m[2] === '-' ? null : Number(m[2]), path })
  }
  return out
}

export function collectChanges(git: Git, base: string, target: string): Change[] {
  const raw = git.runBuffer(['diff-tree', ...DIFF_OPTS, '-z', '--raw', '--no-abbrev', base, target]).stdout
  const num = git.runBuffer(['diff-tree', ...DIFF_OPTS, '-z', '--numstat', base, target]).stdout
  const changes = parseRaw(splitNul(raw))
  const stats = parseNumstat(splitNul(num))
  if (stats.length !== changes.length) throw new Error(`diff-tree 的 raw（${changes.length}）与 numstat（${stats.length}）条目数不一致`)
  changes.forEach((c, idx) => {
    const s = stats[idx]!
    if (s.path !== displayPath(c)) throw new Error(`diff-tree 的 raw 与 numstat 顺序不一致：${displayPath(c)} / ${s.path}`)
    c.added = s.added
    c.deleted = s.deleted
    c.binary = s.added === null && !c.submodule
  })
  return changes
}

/** 单个文件的补丁（只保留从第一个 @@ 开始的 hunk 部分）；没有文本差异时返回空字符串。 */
export function fetchPatch(git: Git, base: string, target: string, c: Change): string {
  const paths = (c.status === 'R' || c.status === 'C') ? [c.oldPath!, c.newPath!] : [displayPath(c)]
  const out = git.run(['diff-tree', '-p', ...DIFF_OPTS, '-U3', '--src-prefix=a/', '--dst-prefix=b/', base, target, '--', ...paths]).stdout
  const at = out.search(/^@@/m)
  return at === -1 ? '' : out.slice(at)
}

export interface BlobInfo {
  size: number
  lfs: boolean
}

const LFS_PREFIX = 'version https://git-lfs.github.com/spec/v1'

/** 批量读取 blob 大小，并识别 Git LFS 指针（只读取 1KB 以内的小 blob 的开头）。 */
export function blobInfo(git: Git, oids: string[]): Map<string, BlobInfo> {
  const result = new Map<string, BlobInfo>()
  const unique = [...new Set(oids.filter((o) => !isNullOid(o)))]
  if (unique.length === 0) return result
  const check = git.run(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: unique.join('\n') + '\n' }).stdout
  const small: string[] = []
  for (const line of check.split('\n')) {
    const [oid, type, size] = line.split(' ')
    if (!oid || type !== 'blob' || size === undefined) continue
    result.set(oid, { size: Number(size), lfs: false })
    if (Number(size) <= 1024) small.push(oid)
  }
  if (small.length > 0) {
    const buf = git.runBuffer(['cat-file', '--batch'], { input: small.join('\n') + '\n' }).stdout
    let pos = 0
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos)
      if (nl === -1) break
      const [oid, , size] = buf.subarray(pos, nl).toString('utf8').split(' ')
      const n = Number(size)
      const content = buf.subarray(nl + 1, nl + 1 + n).toString('utf8')
      if (oid && content.startsWith(LFS_PREFIX)) result.set(oid, { size: n, lfs: true })
      pos = nl + 1 + n + 1
    }
  }
  return result
}

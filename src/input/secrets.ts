// 秘密排除（D13）：在构造模型输入之前判断，匹配的文件只报告"发生了变化"的事实与统计。
// - 新路径与重命名 / 复制的源路径任一匹配清单即排除；被删除文件同样适用。
// - 另外按内容比对：新内容与目标 tree 中任一被排除文件的 blob 完全相同（例如 cp .env notes.txt），同样排除。
// 基于模式的排除不保证发现全部秘密。
import { matchAny } from '../util/glob.ts'
import { splitNul, type Git } from '../git/git.ts'
import { isNullOid, type Change } from './changes.ts'

export function excludedBlobOids(git: Git, target: string, patterns: readonly string[]): Set<string> {
  const oids = new Set<string>()
  const out = git.runBuffer(['ls-tree', '-r', '-z', '--full-tree', target]).stdout
  for (const entry of splitNul(out)) {
    const tab = entry.indexOf('\t')
    if (tab === -1) continue
    const [, type, oid] = entry.slice(0, tab).split(' ')
    const path = entry.slice(tab + 1)
    if (type === 'blob' && oid && matchAny(path, patterns)) oids.add(oid)
  }
  return oids
}

export function findExcluded(git: Git, target: string, changes: Change[], patterns: readonly string[]): Set<Change> {
  const excluded = new Set<Change>()
  for (const c of changes) {
    if (matchAny(c.newPath, patterns) || matchAny(c.oldPath, patterns)) excluded.add(c)
  }
  const secretOids = excludedBlobOids(git, target, patterns)
  for (const c of excluded) {
    if (!isNullOid(c.oldOid)) secretOids.add(c.oldOid)
    if (!isNullOid(c.newOid)) secretOids.add(c.newOid)
  }
  const emptyBlob = git.text(['hash-object', '-t', 'blob', '/dev/null'])
  secretOids.delete(emptyBlob)
  for (const c of changes) {
    if (excluded.has(c)) continue
    if ((!isNullOid(c.newOid) && secretOids.has(c.newOid)) || (!isNullOid(c.oldOid) && secretOids.has(c.oldOid))) excluded.add(c)
  }
  return excluded
}

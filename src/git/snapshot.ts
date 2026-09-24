// 快照（D4）：hook 开始时捕获一次。
// target：有效 index（Git 通过 GIT_INDEX_FILE 传入的临时 index 也算）的 tree——这就是本次提交的 tree；
// base：HEAD 的 tree；unborn HEAD 时用按仓库对象格式计算出的空 tree，不硬编码 SHA-1 常量。
import type { Git } from './git.ts'

export interface Snapshot {
  /** HEAD 的提交 oid；unborn 时为 null。 */
  head: string | null
  base: string
  target: string
  unborn: boolean
  /** base 与 target 相同：没有内容变化。 */
  empty: boolean
}

export function emptyTree(git: Git): string {
  return git.text(['hash-object', '-t', 'tree', '/dev/null'])
}

export function captureSnapshot(git: Git): Snapshot {
  const target = git.text(['write-tree'])
  const head = git.tryText(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  const base = head === null ? emptyTree(git) : git.text(['rev-parse', `${head}^{tree}`])
  return { head, base, target, unborn: head === null, empty: base === target }
}

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
  // HEAD 的提交与 tree 用一次 rev-parse 取得；失败（unborn）时退回空 tree
  const r = git.run(['rev-parse', 'HEAD^{commit}', 'HEAD^{tree}', '--'], { allowFail: true })
  const [head, tree] = r.status === 0 ? r.stdout.split('\n').filter((l) => l !== '') : []
  if (head === undefined || tree === undefined) {
    const base = emptyTree(git)
    return { head: null, base, target, unborn: true, empty: base === target }
  }
  return { head, base: tree, target, unborn: false, empty: tree === target }
}

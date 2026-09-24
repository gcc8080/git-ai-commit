// 特殊 Git 流程检测：来源参数不足以识别，需同时检查状态路径；路径一律通过 git rev-parse --git-path 查询。
import { existsSync } from 'node:fs'
import type { Git } from './git.ts'

export const STATE_PATHS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'] as const
export type SpecialState = (typeof STATE_PATHS)[number]

/** 返回检测到的第一个特殊流程；无则返回 null。查询失败时保守地视为处于特殊流程。 */
export function specialState(git: Git): SpecialState | 'unknown' | null {
  const p = git.paths()
  if (p === null) return 'unknown'
  for (const name of STATE_PATHS) if (existsSync(p.path[name])) return name
  return null
}

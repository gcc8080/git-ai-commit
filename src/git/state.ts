// 特殊 Git 流程检测：来源参数不足以识别，需同时检查状态路径；路径一律通过 git rev-parse --git-path 查询。
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Git } from './git.ts'

export const STATE_PATHS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'] as const
export type SpecialState = (typeof STATE_PATHS)[number]

/** 返回检测到的第一个特殊流程；无则返回 null。查询失败时保守地视为处于特殊流程。 */
export function specialState(git: Git): SpecialState | 'unknown' | null {
  const r = git.run(['rev-parse', ...STATE_PATHS.flatMap((p) => ['--git-path', p])], { allowFail: true })
  if (r.status !== 0) return 'unknown'
  const paths = r.stdout.split('\n').filter((l) => l !== '')
  if (paths.length !== STATE_PATHS.length) return 'unknown'
  for (let i = 0; i < STATE_PATHS.length; i++) {
    if (existsSync(resolve(git.cwd, paths[i]!))) return STATE_PATHS[i]!
  }
  return null
}

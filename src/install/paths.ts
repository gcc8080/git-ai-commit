// 安装相关的路径解析（D18、D19）：一律通过 git rev-parse 解析，不假设工作区中的 .git 是目录。
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Git } from '../git/git.ts'

function canonical(p: string): string {
  // 目录可能不存在：对最近的已存在祖先取 realpath，再拼回剩余部分（处理 /var 与 /private/var 之类的符号链接）
  let cur = resolve(p)
  const rest: string[] = []
  while (!existsSync(cur)) {
    rest.unshift(cur.slice(dirname(cur).length + 1))
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return join(realpathSync(cur), ...rest)
}

export interface HooksLocation {
  /** Git 实际使用的 hooks 目录（遵循 core.hooksPath）。 */
  effective: string
  /** 本仓库自身的默认 hooks 目录：<common-dir>/hooks。 */
  defaultDir: string
  isDefault: boolean
  /** core.hooksPath 的值与来源（例如 file:/Users/x/.gitconfig）。 */
  hooksPathConfig: { value: string; origin: string } | null
}

export function hooksLocation(git: Git): HooksLocation {
  const effective = canonical(git.text(['rev-parse', '--path-format=absolute', '--git-path', 'hooks']))
  const common = git.text(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const defaultDir = canonical(join(common, 'hooks'))
  const cfg = git.tryText(['config', '--show-origin', '--get', 'core.hooksPath'])
  let hooksPathConfig: HooksLocation['hooksPathConfig'] = null
  if (cfg !== null) {
    const tab = cfg.indexOf('\t')
    hooksPathConfig = { origin: cfg.slice(0, tab), value: cfg.slice(tab + 1) }
  }
  return { effective, defaultDir, isDefault: effective === defaultDir, hooksPathConfig }
}

/** 本仓库的所有 worktree（跳过不可用的条目）。 */
export function worktrees(git: Git): string[] {
  const out = git.text(['worktree', 'list', '--porcelain'])
  const dirs: string[] = []
  let current: string | null = null
  let skip = false
  const flush = () => {
    if (current !== null && !skip && existsSync(current)) dirs.push(current)
    current = null
    skip = false
  }
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      current = line.slice('worktree '.length)
    } else if (line === 'bare' || line.startsWith('prunable')) {
      skip = true
    } else if (line === '') {
      flush()
    }
  }
  flush()
  return dirs
}

/** 某个 worktree 的状态目录根：<该 worktree 私有 git 目录>/ai-commit。 */
export function stateRoot(worktree: string, env: NodeJS.ProcessEnv = process.env): string {
  return new Git(worktree, env).text(['rev-parse', '--path-format=absolute', '--git-path', 'ai-commit'])
}

export function stateDir(worktree: string, installId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(stateRoot(worktree, env), installId)
}

export const STATE_SUBDIRS = ['tasks', 'locks', 'cache'] as const

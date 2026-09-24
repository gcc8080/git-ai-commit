// 本工具写入的 hook 与状态目录（D18、D19）。
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseOwnership, type HookName } from '../hook/templates.ts'
import { stateDir, STATE_SUBDIRS } from './paths.ts'

export const HOOK_NAMES: HookName[] = ['prepare-commit-msg', 'post-index-change']

export function readHook(dir: string, name: string): string | null {
  const f = join(dir, name)
  return existsSync(f) ? readFileSync(f, 'utf8') : null
}

/** 已安装的安装标识（从本工具写入的 hook 的标记行读取）。 */
export function installedId(hooksDir: string): string | null {
  for (const name of HOOK_NAMES) {
    const content = readHook(hooksDir, name)
    const own = content === null ? null : parseOwnership(content)
    if (own !== null) return own.installId
  }
  return null
}

/** 创建状态目录。只有 install 与前台 prepare-commit-msg 可以调用；后台任务从不创建目录（D19）。 */
export function ensureStateDirs(worktree: string, installId: string, env: NodeJS.ProcessEnv): string {
  const dir = stateDir(worktree, installId, env)
  for (const sub of STATE_SUBDIRS) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 })
  return dir
}

export function writeHook(dir: string, name: HookName, content: string): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, content)
  chmodSync(file, 0o755)
}

/** 写入 hook 模板的运行时路径：当前 Node 与脚本的真实路径（D10）。 */
export function runtimePaths(): { node: string; script: string } {
  return { node: realpathSync(process.execPath), script: realpathSync(process.argv[1]!) }
}

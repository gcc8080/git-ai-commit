// 按 PATH 查找可执行文件。
import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

export function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 按 PATH 查找命令；给的是绝对路径时直接检查该路径。 */
export function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string | null {
  if (isAbsolute(command)) return isExecutable(command) ? command : null
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, command)
    if (existsSync(candidate) && isExecutable(candidate)) return candidate
  }
  return null
}

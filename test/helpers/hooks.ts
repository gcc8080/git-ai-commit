import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Repo } from './repo.ts'

/** 在夹具仓库中写一个直接运行 node 脚本的 hook（测试专用，不是产品模板）。 */
export function writeNodeHook(repo: Repo, name: string, script: string): string {
  const hooksDir = repo.git(['rev-parse', '--path-format=absolute', '--git-path', 'hooks']).stdout.trim()
  const file = join(hooksDir, name)
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" --no-warnings "${script}" "$@"\n`)
  chmodSync(file, 0o755)
  return file
}

export function writeShellHook(repo: Repo, name: string, body: string): string {
  const hooksDir = repo.git(['rev-parse', '--path-format=absolute', '--git-path', 'hooks']).stdout.trim()
  const file = join(hooksDir, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

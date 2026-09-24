// warm：后台预热入口（D3、D16）。
// - 由 post-index-change 在后台启动（不带 --detach）：生成任务令牌，以脱离方式派生真正的后台任务（独立进程组，
//   令牌出现在它的命令行中），然后立即退出；
// - 带 --detach 的进程就是后台任务本身：全程不输出，结果只写入状态目录。
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { Command } from '../cli/args.ts'
import type { Io } from '../main.ts'
import { barrierFromEnv, runWarmTask } from '../prewarm/task.ts'

/** git 给 hook 的 GIT_INDEX_FILE 可能是写 index 时的临时 lock 文件，去抖之后已不存在：后台任务一律读取默认 index。 */
export function taskEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const e = { ...env }
  delete e.GIT_INDEX_FILE
  return e
}

export async function warmCommand(cmd: Command, _io: Io, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (cmd.kind !== 'warm') return 2
  if (!cmd.detach) {
    const token = randomBytes(12).toString('hex')
    const child = spawn(process.execPath, [process.argv[1]!, 'warm', '--install-id', cmd.installId, '--detach', '--token', token], {
      cwd: process.cwd(), env: taskEnv(env), detached: true, stdio: 'ignore',
    })
    child.on('error', () => {})
    child.unref()
    return 0
  }
  if (cmd.token === undefined || !/^[0-9a-f]{24}$/.test(cmd.token)) return 2
  await runWarmTask({ cwd: process.cwd(), env, installId: cmd.installId, token: cmd.token, ...(barrierFromEnv(env) ? { barrier: barrierFromEnv(env)! } : {}) })
  return 0
}

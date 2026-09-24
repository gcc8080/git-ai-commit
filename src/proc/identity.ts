// 进程身份核对与进程组终止（D16、D19）：
// - 向进程发信号前，先按任务令牌核对它确实是本工具的任务（防止 pid 被复用后误杀无关进程）；
// - 终止进程组：TERM → 等待 → KILL → 确认整组都已退出；确认不了就返回 false。
import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

export function processCommand(pid: number): string | null {
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  if (r.status !== 0) return null
  const out = r.stdout.trim()
  return out === '' ? null : out
}

/** pid 对应的进程仍然存在，且命令行里带着记录的任务令牌。 */
export function isTaskProcess(pid: number, token: string): boolean {
  const cmd = processCommand(pid)
  return cmd !== null && cmd.includes(token)
}

export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function terminateGroup(pgid: number, graceMs = 1000): Promise<boolean> {
  const signal = (sig: NodeJS.Signals) => {
    try { process.kill(-pgid, sig) } catch { /* 已退出 */ }
  }
  if (!groupAlive(pgid)) return true
  signal('SIGTERM')
  for (let t = 0; t < graceMs; t += 50) {
    if (!groupAlive(pgid)) return true
    await sleep(50)
  }
  signal('SIGKILL')
  for (let t = 0; t < 2000; t += 50) {
    if (!groupAlive(pgid)) return true
    await sleep(50)
  }
  return !groupAlive(pgid)
}

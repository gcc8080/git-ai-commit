// 测试辅助：进程是否仍在运行。已退出但尚未被父进程回收的僵尸不算——kill(pid, 0) 会把它当作存在。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

export function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false
  }
  let state: string
  if (existsSync(`/proc/${pid}/stat`)) {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8')
    state = s.slice(s.lastIndexOf(')') + 2).split(' ')[0] ?? ''
  } else {
    state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  }
  return state !== '' && !state.startsWith('Z')
}

/** 全部进程的命令行：有 /proc 时直接读取（不依赖 procps），否则用 ps -ww。 */
export function allCommands(): string[] {
  if (existsSync('/proc/self/cmdline')) {
    const out: string[] = []
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      try {
        const cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')
        if (cmd !== '') out.push(cmd)
      } catch {
        // 进程已退出
      }
    }
    return out
  }
  return spawnSync('ps', ['-A', '-ww', '-o', 'command='], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
}

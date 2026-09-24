// 进程身份核对与进程组终止（D16、D19）：
// - 向进程发信号前，先按任务令牌核对它确实是本工具的任务（防止 pid 被复用后误杀无关进程）；
// - 终止进程组：TERM → 等待 → KILL → 确认整组都已退出；确认不了就返回 false。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * 进程的完整命令行；进程不存在时返回 null。任务令牌位于命令行末尾，必须拿到完整内容：
 * 有 /proc 的系统（Linux）直接读 /proc/<pid>/cmdline；其他系统用 ps -ww（procps 的 ps 在输出被重定向时可能按 80 列截断）。
 */
export function processCommand(pid: number): string | null {
  if (existsSync('/proc/self/cmdline')) {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      const cmd = raw.split('\0').filter((x) => x !== '').join(' ')
      return cmd === '' ? null : cmd
    } catch {
      return null
    }
  }
  const r = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  if (r.status !== 0) return null
  const out = r.stdout.trim()
  return out === '' ? null : out
}

/** pid 对应的进程仍然存在，且命令行里带着记录的任务令牌。 */
export function isTaskProcess(pid: number, token: string): boolean {
  const cmd = processCommand(pid)
  return cmd !== null && cmd.includes(token)
}

/**
 * 进程组里是否还有未退出的成员。kill(-pgid, 0) 只说明组里还有进程——包括尚未被父进程回收的僵尸（Linux 上照样成功，
 * macOS 上返回 EPERM）。父进程不回收时（容器里不回收孤儿的 PID 1、父进程阻塞在同步调用中），整组会一直"存活"，
 * 接管与卸载永远确认不了退出。所以 kill 表明组还在时，再确认组里有非僵尸成员。
 */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false
  }
  return groupHasLiveMember(pgid) ?? true
}

/** 进程组中是否有非僵尸成员；一个成员都看不到或无法查询时返回 null（交给 kill 的结论）。 */
export function groupHasLiveMember(pgid: number): boolean | null {
  return existsSync('/proc/self/stat') ? procGroupHasLiveMember(pgid) : psGroupHasLiveMember(pgid)
}

const isLiveState = (state: string) => state !== '' && !state.startsWith('Z') && state !== 'X'

/** /proc/<pid>/stat 的状态与进程组；comm 可能含空格与括号，从最后一个 ')' 之后取字段。 */
function procStat(pid: number | string): { state: string; pgrp: number } | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ')
    return { state: f[0] ?? '', pgrp: Number(f[2]) }
  } catch {
    return null
  }
}

function procGroupHasLiveMember(pgid: number): boolean | null {
  const leader = procStat(pgid)
  if (leader !== null && leader.pgrp === pgid && isLiveState(leader.state)) return true
  let names: string[]
  try { names = readdirSync('/proc') } catch { return null }
  let seen = false
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const st = procStat(name)
    if (st === null || st.pgrp !== pgid) continue
    if (isLiveState(st.state)) return true
    seen = true
  }
  return seen ? false : null
}

function psGroupHasLiveMember(pgid: number): boolean | null {
  const r = spawnSync('ps', ['-A', '-o', 'pgid=,stat='], { encoding: 'utf8' })
  if (r.status !== 0) return null
  let seen = false
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)/.exec(line)
    if (!m || Number(m[1]) !== pgid) continue
    if (isLiveState(m[2]!)) return true
    seen = true
  }
  return seen ? false : null
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

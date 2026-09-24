// 接管的统一规则（D16、[评审] C02）：只有在确认旧持有者的进程组已经退出之后，才能建立下一代次的锁文件。
// 1. 核对身份：pid 的命令行里没有记录的标识（pid 已被复用）→ 原进程已退出，不向这个 pid 发任何信号；
//    pid 已不存在、但进程组仍在（后端子进程还活着）→ 进程组 id 在组存续期间不会被复用，组内仍是旧任务的进程；
// 2. 旧持有者仍在：只有强制刷新或超龄时，才终止它的进程组并确认整组退出；否则不接管；
// 3. 确认不了退出就不接管；前台持有者（用户终端里的 git commit）从不发信号。
import { basename } from 'node:path'
import { groupAlive, processCommand, terminateGroup } from '../proc/identity.ts'
import type { LockInfo, Registration } from './store.ts'

export type TakeoverResult = 'gone' | 'alive' | 'unconfirmed'

export interface Holder {
  pid: number
  pgid: number | null
  token: string
  startedAt: number
  kind: 'background' | 'foreground'
}

export interface TakeoverOptions {
  /** 强制刷新（或以最新快照为准取代旧的后台任务）：不看是否超龄。 */
  force: boolean
  /** 超龄阈值：总预算加余量。 */
  staleMs: number
  now?: number
  graceMs?: number
}

export function holderOfLock(l: LockInfo): Holder {
  return { pid: l.pid, pgid: l.pgid, token: l.token, startedAt: l.startedAt, kind: l.kind }
}

export function holderOfTask(r: Registration): Holder {
  return { pid: r.pid, pgid: r.pgid, token: r.token, startedAt: r.startedAt, kind: 'background' }
}

/** 持有者的当前状态（不发信号）。 */
export function holderState(h: Holder): 'gone' | 'running' {
  const cmd = processCommand(h.pid)
  if (cmd !== null && !cmd.includes(h.token)) return 'gone'
  if (cmd !== null) return 'running'
  return h.kind === 'background' && h.pgid !== null && groupAlive(h.pgid) ? 'running' : 'gone'
}

/**
 * 终止后台任务登记的后端进程组。进程组 id 在组存续期间不会被复用：组仍存活时，组长已不存在，或组长的命令行就是该后端，
 * 才能确定是本工具启动的那一组；组长的命令行是别的程序（pid 已被复用）就不发信号。
 */
/** 命令行中以路径分段或独立词的形式出现了 name（避免短名字误匹配到别的程序）。 */
export function mentions(cmd: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[\\s/])${escaped}(\\s|$)`).test(cmd)
}

export async function terminateBackend(backend: { pgid: number; command: string } | null | undefined, graceMs?: number): Promise<boolean> {
  if (!backend || !groupAlive(backend.pgid)) return true
  const cmd = processCommand(backend.pgid)
  if (cmd !== null && !mentions(cmd, basename(backend.command))) return true
  return terminateGroup(backend.pgid, graceMs)
}

/**
 * 按接管规则处理持有者。backend 返回持有者登记的后端进程组：在任务进程组确认退出之后再读取——此时登记不会再变。
 */
export async function takeover(h: Holder, o: TakeoverOptions, backend: () => Registration['backend'] = () => null): Promise<TakeoverResult> {
  if (holderState(h) === 'gone') return (await terminateBackend(backend(), o.graceMs)) ? 'gone' : 'unconfirmed'
  if (h.kind === 'foreground' || h.pgid === null) return 'alive'
  const age = (o.now ?? Date.now()) - h.startedAt
  if (!o.force && age <= o.staleMs) return 'alive'
  // 发信号前再核对一次：两次核对之间旧持有者可能已经退出、pid 被复用
  if (holderState(h) !== 'gone' && !(await terminateGroup(h.pgid, o.graceMs))) return 'unconfirmed'
  return (await terminateBackend(backend(), o.graceMs)) ? 'gone' : 'unconfirmed'
}

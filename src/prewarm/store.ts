// 预热状态目录（D16、D19）：<git-path ai-commit>/<安装标识>/{tasks,locks,cache}。
// 这里的写入都只在已经存在的目录中进行：先写临时文件，再用 link（排他创建）或 rename（替换）落到最终路径。
// 从不创建目录——目录被卸载改名后，任何登记、加锁、发布都会失败，任务随之放弃，目录也不会被重建。
import { randomBytes } from 'node:crypto'
import { existsSync, linkSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Rules } from '../config/rules.ts'
import { SCHEMA_VERSION, validateOutput, type Candidate } from '../output/schema.ts'

export interface StatePaths {
  dir: string
  tasks: string
  locks: string
  cache: string
}

export function statePaths(dir: string): StatePaths {
  return { dir, tasks: join(dir, 'tasks'), locks: join(dir, 'locks'), cache: join(dir, 'cache') }
}

const tmpName = (path: string) => `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
const isTmp = (name: string) => name.includes('.tmp-')

function removeQuiet(path: string): void {
  try { unlinkSync(path) } catch { /* 不存在 */ }
}

/** 以完整内容排他创建：目标已存在或所在目录不存在时返回 false。读者不会看到写了一半的文件。 */
export function createExclusive(path: string, content: string): boolean {
  const tmp = tmpName(path)
  try {
    writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 })
  } catch {
    return false
  }
  try {
    linkSync(tmp, path)
    return true
  } catch {
    return false
  } finally {
    removeQuiet(tmp)
  }
}

/** 原子地替换内容：所在目录不存在时返回 false。 */
export function replaceAtomic(path: string, content: string): boolean {
  const tmp = tmpName(path)
  try {
    writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 })
    renameSync(tmp, path)
    return true
  } catch {
    removeQuiet(tmp)
    return false
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

// ---------- 任务登记（D19） ----------

export interface Registration {
  pid: number
  /** 任务自己的进程组（后台任务以脱离方式启动，是组长）。 */
  pgid: number
  /** 随机令牌，同时出现在任务进程的命令行中，用于核对进程身份。 */
  token: string
  phase: 'debounce' | 'generating'
  key: string | null
  startedAt: number
  /** 后端运行在自己的进程组中（执行器超时时整组终止）：记录它，接管与卸载时一并终止。 */
  backend?: { pgid: number; command: string } | null
}

const regPath = (p: StatePaths, token: string) => join(p.tasks, `${token}.json`)

export function register(p: StatePaths, reg: Registration): boolean {
  return createExclusive(regPath(p, reg.token), JSON.stringify(reg))
}

/** 更新自己的登记；登记文件已不在（目录被改名或被清理）时返回 false。 */
export function updateRegistration(p: StatePaths, reg: Registration): boolean {
  if (!existsSync(regPath(p, reg.token))) return false
  return replaceAtomic(regPath(p, reg.token), JSON.stringify(reg))
}

export function readRegistration(p: StatePaths, token: string): Registration | null {
  const v = readJson(regPath(p, token))
  return isRegistration(v) ? v : null
}

export function unregister(p: StatePaths, token: string): void {
  removeQuiet(regPath(p, token))
}

function isRegistration(v: unknown): v is Registration {
  const r = v as Partial<Registration> | null
  return r !== null && typeof r === 'object' && typeof r.pid === 'number' && typeof r.pgid === 'number' && typeof r.token === 'string' && typeof r.startedAt === 'number'
}

export function readRegistrations(p: StatePaths): Registration[] {
  let names: string[]
  try { names = readdirSync(p.tasks) } catch { return [] }
  const regs: Registration[] = []
  for (const name of names) {
    if (!name.endsWith('.json') || isTmp(name)) continue
    const v = readJson(join(p.tasks, name))
    if (isRegistration(v)) regs.push(v)
  }
  return regs
}

/** 去抖：记录最近一次触发的任务令牌；等待结束后只有最新的任务继续。 */
export function setLatest(p: StatePaths, token: string): boolean {
  return replaceAtomic(join(p.tasks, 'latest'), token)
}

export function latest(p: StatePaths): string | null {
  try { return readFileSync(join(p.tasks, 'latest'), 'utf8') } catch { return null }
}

// ---------- 锁（D16）：<key>.lock.<代次>，按代次排他创建 ----------

export interface LockInfo {
  key: string
  gen: number
  kind: 'background' | 'foreground'
  pid: number
  /** 后台任务的进程组；前台持有者（用户终端里的 git commit）为 null，永远不向它发信号。 */
  pgid: number | null
  /** 出现在持有者进程命令行中的标识：后台为随机令牌，前台为脚本路径与子命令。 */
  token: string
  startedAt: number
}

const lockPath = (p: StatePaths, key: string, gen: number) => join(p.locks, `${key}.lock.${gen}`)

export function listLocks(p: StatePaths, key: string): Array<{ gen: number; info: LockInfo | null }> {
  let names: string[]
  try { names = readdirSync(p.locks) } catch { return [] }
  const prefix = `${key}.lock.`
  const locks: Array<{ gen: number; info: LockInfo | null }> = []
  for (const name of names) {
    if (!name.startsWith(prefix) || isTmp(name)) continue
    const gen = Number(name.slice(prefix.length))
    if (!Number.isInteger(gen) || gen < 1) continue
    const v = readJson(join(p.locks, name)) as LockInfo | null
    locks.push({ gen, info: v !== null && typeof v === 'object' && typeof v.pid === 'number' && typeof v.token === 'string' ? v : null })
  }
  return locks.sort((a, b) => a.gen - b.gen)
}

export function createLock(p: StatePaths, info: LockInfo): boolean {
  return createExclusive(lockPath(p, info.key, info.gen), JSON.stringify(info))
}

export function lockExists(p: StatePaths, key: string, gen: number): boolean {
  return existsSync(lockPath(p, key, gen))
}

/** 释放只删除自己代次的锁文件。 */
export function releaseLock(p: StatePaths, key: string, gen: number): void {
  removeQuiet(lockPath(p, key, gen))
}

/** 新代次的持有者清理已确认退出的旧代次锁文件。 */
export function removeLowerLocks(p: StatePaths, key: string, gen: number): void {
  for (const l of listLocks(p, key)) if (l.gen < gen) releaseLock(p, key, l.gen)
}

// ---------- 缓存条目（D5） ----------

export interface ProducedBy {
  profile: string
  harness: string
  model: string
}

export type Entry =
  | { v: number; state: 'ready'; key: string; candidate: Candidate; profile: string; producedBy: ProducedBy; createdAt: number }
  | { v: number; state: 'failed'; key: string; failureClass: string; createdAt: number }

const entryPath = (p: StatePaths, key: string) => join(p.cache, `${key}.json`)

/** 读取并按当前 schema 重新校验；损坏、版本不符或不再合规的条目视为未命中并删除。 */
export function readEntry(p: StatePaths, key: string, rules: Rules): Entry | null {
  const path = entryPath(p, key)
  if (!existsSync(path)) return null
  const v = readJson(path) as Partial<Entry> | null
  const drop = () => { removeQuiet(path); return null }
  if (v === null || typeof v !== 'object' || v.v !== SCHEMA_VERSION || v.key !== key || typeof v.createdAt !== 'number') return drop()
  if (v.state === 'failed') return typeof v.failureClass === 'string' ? (v as Entry) : drop()
  if (v.state !== 'ready' || typeof v.profile !== 'string' || typeof v.producedBy !== 'object' || v.producedBy === null) return drop()
  const checked = validateOutput(v.candidate, { rules, inputText: null })
  if (!checked.ok || checked.value.kind !== 'candidate') return drop()
  return { ...(v as Entry & { state: 'ready' }), candidate: checked.value.candidate }
}

/** 发布：先写临时文件，确认没有比自己更高代次的锁，再以 rename 替换。 */
export function publish(p: StatePaths, key: string, gen: number, entry: Entry): boolean {
  const path = entryPath(p, key)
  const tmp = tmpName(path)
  try {
    writeFileSync(tmp, JSON.stringify(entry), { flag: 'wx', mode: 0o600 })
  } catch {
    return false
  }
  if (listLocks(p, key).some((l) => l.gen > gen)) {
    removeQuiet(tmp)
    return false
  }
  try {
    renameSync(tmp, path)
    return true
  } catch {
    removeQuiet(tmp)
    return false
  }
}

export function removeEntry(p: StatePaths, key: string): void {
  removeQuiet(entryPath(p, key))
}

/** 容量与保留：删除超过保留期的条目，再按时间从旧到新删到不超过上限。 */
export function prune(p: StatePaths, opts: { maxEntries: number; maxAgeMs: number; now?: number }): number {
  const now = opts.now ?? Date.now()
  let names: string[]
  try { names = readdirSync(p.cache) } catch { return 0 }
  const entries: Array<{ path: string; mtime: number }> = []
  for (const name of names) {
    const path = join(p.cache, name)
    let mtime: number
    try {
      mtime = statSync(path).mtimeMs
    } catch {
      continue
    }
    // 其他任务正在发布时留下的临时文件：只清理明显过期的残留
    if (isTmp(name)) {
      if (now - mtime > 10 * 60_000) removeQuiet(path)
      continue
    }
    entries.push({ path, mtime })
  }
  entries.sort((a, b) => a.mtime - b.mtime)
  let removed = 0
  const keep = entries.filter((e) => {
    if (now - e.mtime > opts.maxAgeMs) { removeQuiet(e.path); removed++; return false }
    return true
  })
  for (let i = 0; i < keep.length - opts.maxEntries; i++) {
    removeQuiet(keep[i]!.path)
    removed++
  }
  return removed
}

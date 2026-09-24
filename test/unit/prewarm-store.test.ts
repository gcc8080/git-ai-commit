// 第三期的状态层、缓存键与接管规则（D5、D16）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Sandbox } from '../helpers/repo.ts'
import { ROOT } from '../helpers/paths.ts'
import {
  createLock, listLocks, prune, publish, readEntry, register, readRegistrations, releaseLock, removeLowerLocks, statePaths,
  updateRegistration, type Entry, type LockInfo, type StatePaths,
} from '../../src/prewarm/store.ts'
import { takeover, type Holder } from '../../src/prewarm/takeover.ts'
import { processCommand } from '../../src/proc/identity.ts'
import { cacheKey, canonicalJson, type KeyInput } from '../../src/prewarm/key.ts'
import { effectiveRules } from '../../src/config/rules.ts'
import { SCHEMA_VERSION } from '../../src/output/schema.ts'
import type { Profile } from '../../src/config/machine.ts'

function stateIn(sb: Sandbox): StatePaths {
  const p = statePaths(join(sb.root, 'state'))
  for (const d of [p.tasks, p.locks, p.cache]) mkdirSync(d, { recursive: true })
  return p
}

const KEY = 'a'.repeat(64)
const lock = (gen: number, over: Partial<LockInfo> = {}): LockInfo => ({ key: KEY, gen, kind: 'background', pid: 1, pgid: 1, token: 't', startedAt: Date.now(), ...over })
const ready = (subject: string): Entry => ({
  v: SCHEMA_VERSION, state: 'ready', key: KEY, candidate: { type: 'fix', scope: null, subject, body: [], breakingChange: null },
  profile: 'p', producedBy: { profile: 'p', harness: 'claude', model: 'm' }, createdAt: Date.now(),
})

// ---------- 状态层 ----------

test('从不创建目录：目录不存在时登记、加锁、发布都失败', (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const p = statePaths(join(sb.root, 'missing'))
  assert.equal(register(p, { pid: 1, pgid: 1, token: 'x', phase: 'debounce', key: null, startedAt: 0 }), false)
  assert.equal(createLock(p, lock(1)), false)
  assert.equal(publish(p, KEY, 1, ready('修复')), false)
  assert.equal(existsSync(p.dir), false)
})

test('登记：排他创建；更新只针对自己已存在的登记', (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const p = stateIn(sb)
  const reg = { pid: 1, pgid: 1, token: 'tok', phase: 'debounce' as const, key: null, startedAt: 1 }
  assert.equal(register(p, reg), true)
  assert.equal(register(p, reg), false)
  assert.equal(updateRegistration(p, { ...reg, phase: 'generating', key: KEY }), true)
  assert.deepEqual(readRegistrations(p).map((r) => r.phase), ['generating'])
  assert.equal(updateRegistration(p, { ...reg, token: 'other' }), false)
})

test('锁：多个进程同时创建同一代次，只有一个成功', async (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const p = stateIn(sb)
  const go = join(sb.root, 'go')
  const script = `
    import { existsSync } from 'node:fs'
    import { createLock, statePaths } from ${JSON.stringify(join(ROOT, 'src/prewarm/store.ts'))}
    while (!existsSync(${JSON.stringify(go)})) {}
    const ok = createLock(statePaths(${JSON.stringify(p.dir)}), { key: ${JSON.stringify(KEY)}, gen: 1, kind: 'background', pid: process.pid, pgid: process.pid, token: 't', startedAt: Date.now() })
    process.stdout.write(ok ? 'won' : 'lost')
  `
  const procs = Array.from({ length: 8 }, () => spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'ignore'] }))
  const outs = procs.map((c) => new Promise<string>((res) => { let s = ''; c.stdout!.on('data', (d) => { s += d }); c.on('close', () => res(s)) }))
  await new Promise((r) => setTimeout(r, 500))
  writeFileSync(go, '')
  const results = await Promise.all(outs)
  assert.equal(results.filter((r) => r === 'won').length, 1, results.join(','))
  assert.deepEqual(listLocks(p, KEY).map((l) => l.gen), [1])
})

test('锁：释放只删自己代次；新代次清理旧代次；发布前发现更高代次就放弃', (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const p = stateIn(sb)
  assert.equal(createLock(p, lock(1)), true)
  assert.equal(createLock(p, lock(2)), true)
  releaseLock(p, KEY, 3)
  assert.deepEqual(listLocks(p, KEY).map((l) => l.gen), [1, 2])
  assert.equal(publish(p, KEY, 1, ready('旧代次的结果')), false, '存在更高代次的锁时，旧代次不能发布')
  assert.equal(publish(p, KEY, 2, ready('新代次的结果')), true)
  removeLowerLocks(p, KEY, 2)
  assert.deepEqual(listLocks(p, KEY).map((l) => l.gen), [2])
  const e = readEntry(p, KEY, effectiveRules({}))
  assert.equal(e?.state === 'ready' && e.candidate.subject, '新代次的结果')
})

test('缓存条目：按当前规则重新校验，损坏、版本不符或不再合规的条目视为未命中并删除', (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const p = stateIn(sb)
  const rules = effectiveRules({})
  const file = join(p.cache, `${KEY}.json`)
  for (const bad of ['{"v":1,"state":"ready"', JSON.stringify({ ...ready('修复'), v: SCHEMA_VERSION + 1 }), JSON.stringify(ready('add english subject')), JSON.stringify({ ...ready('修复'), key: 'b'.repeat(64) })]) {
    writeFileSync(file, bad)
    assert.equal(readEntry(p, KEY, rules), null, bad.slice(0, 40))
    assert.equal(existsSync(file), false, '不合规的条目被删除')
  }
  assert.equal(publish(p, KEY, 1, ready('修复缓存')), true)
  assert.equal(readEntry(p, KEY, rules)?.state, 'ready')
})

test('容量与保留：超过保留期的条目被清理，再按时间从旧到新删到不超过上限', (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const p = stateIn(sb)
  const now = Date.now()
  for (let i = 0; i < 6; i++) {
    const f = join(p.cache, `${String(i).repeat(64)}.json`)
    writeFileSync(f, '{}')
    const at = new Date(now - (6 - i) * 60_000 - (i === 0 ? 40 * 24 * 3600_000 : 0))
    utimesSync(f, at, at)
  }
  assert.equal(prune(p, { maxEntries: 3, maxAgeMs: 30 * 24 * 3600_000, now }), 3)
  assert.deepEqual(readdirSync(p.cache).map((n) => n[0]).sort(), ['3', '4', '5'])
})

// ---------- 缓存键 ----------

test('缓存键：规范化 JSON 与参数敏感性', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}')
  const profile: Profile = { name: 'p', harness: 'pi', model: 'm', provider: 'openai-codex', effort: null, executable: null }
  const base: KeyInput = { base: 'b1', target: 't1', profile, backendVersion: '1.0.0', rules: effectiveRules({}), historyOids: ['h1'] }
  const k = cacheKey(base)
  assert.equal(cacheKey({ ...base, profile: { ...profile, name: '改名' } }), k, 'profile 名称不影响')
  const cases: Array<[string, KeyInput]> = [
    ['target', { ...base, target: 't2' }],
    ['provider', { ...base, profile: { ...profile, provider: 'openai' } }],
    ['后端版本', { ...base, backendVersion: '1.0.1' }],
    ['语言', { ...base, rules: effectiveRules({ language: 'en' }) }],
    ['排除清单', { ...base, rules: effectiveRules({ exclude: ['*.secret'] }) }],
    ['历史样本', { ...base, historyOids: ['h2'] }],
  ]
  for (const [why, changed] of cases) assert.notEqual(cacheKey(changed), k, why)
})

// ---------- 接管规则 ----------

interface Spawned { holder: ChildProcess; childPid: number | null; token: string }

/** 以独立进程组启动一个模拟的任务持有者：命令行带令牌；可选地在同组内派生一个后端子进程。 */
async function spawnHolder(sb: Sandbox, opts: { child?: boolean; ignoreTerm?: boolean; exitAfterChild?: boolean } = {}): Promise<Spawned> {
  const token = `tok${Math.random().toString(16).slice(2, 14)}`
  const pidFile = join(sb.root, `${token}.child`)
  const script = `
    const { spawn } = require('node:child_process'); const fs = require('node:fs')
    if (${!!opts.ignoreTerm}) process.on('SIGTERM', () => {})
    if (${!!opts.child}) {
      const c = spawn(process.execPath, ['-e', ${JSON.stringify(`${opts.ignoreTerm ? "process.on('SIGTERM', () => {});" : ''} setInterval(() => {}, 1000)`)}], { stdio: 'ignore' })
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid))
      if (${!!opts.exitAfterChild}) process.exit(0)
    }
    setInterval(() => {}, 1000)
  `
  const holder = spawn(process.execPath, ['-e', script, '--', token], { detached: true, stdio: 'ignore' })
  let childPid: number | null = null
  if (opts.child) {
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 30))
    childPid = Number((await import('node:fs')).readFileSync(pidFile, 'utf8'))
  } else {
    await new Promise((r) => setTimeout(r, 200))
  }
  return { holder, childPid, token }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const cleanupGroup = (pgid: number) => { try { process.kill(-pgid, 'SIGKILL') } catch { /* 已退出 */ } }
const asHolder = (s: Spawned, over: Partial<Holder> = {}): Holder => ({ pid: s.holder.pid!, pgid: s.holder.pid!, token: s.token, startedAt: Date.now() - 60_000, kind: 'background', ...over })

test('接管：锁已超龄、持有者与后端子进程仍存活 → 终止整个进程组并确认退出后才接管', async (t) => {
  const sb = new Sandbox()
  const s = await spawnHolder(sb, { child: true })
  t.after(() => { cleanupGroup(s.holder.pid!); sb.cleanup() })
  assert.equal(await takeover(asHolder(s, { startedAt: Date.now() }), { force: false, staleMs: 30_000 }), 'alive', '未超龄不接管')
  assert.ok(alive(s.holder.pid!))
  assert.equal(await takeover(asHolder(s), { force: false, staleMs: 30_000 }), 'gone')
  assert.equal(alive(s.holder.pid!), false)
  assert.equal(alive(s.childPid!), false, '后端子进程随进程组一起终止')
})

test('接管：持有者已退出但后端子进程仍在进程组内 → 仍要终止该进程组', async (t) => {
  const sb = new Sandbox()
  const s = await spawnHolder(sb, { child: true, exitAfterChild: true })
  t.after(() => { cleanupGroup(s.holder.pid!); sb.cleanup() })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(alive(s.childPid!), true)
  assert.equal(await takeover(asHolder(s), { force: false, staleMs: 30_000 }), 'gone')
  assert.equal(alive(s.childPid!), false)
})

test('接管：取消后未及时退出（忽略 SIGTERM）→ 升级为强制终止，确认整组退出', async (t) => {
  const sb = new Sandbox()
  const s = await spawnHolder(sb, { child: true, ignoreTerm: true })
  t.after(() => { cleanupGroup(s.holder.pid!); sb.cleanup() })
  assert.equal(await takeover(asHolder(s, { startedAt: Date.now() }), { force: true, staleMs: 30_000, graceMs: 300 }), 'gone')
  assert.equal(alive(s.holder.pid!), false)
  assert.equal(alive(s.childPid!), false)
})

test('接管：旧任务在身份核对之后被暂停（SIGSTOP）→ 强制终止仍能确认退出', async (t) => {
  const sb = new Sandbox()
  const s = await spawnHolder(sb, { child: true })
  t.after(() => { cleanupGroup(s.holder.pid!); sb.cleanup() })
  process.kill(-s.holder.pid!, 'SIGSTOP')
  assert.equal(await takeover(asHolder(s), { force: true, staleMs: 30_000, graceMs: 300 }), 'gone')
  assert.equal(alive(s.holder.pid!), false)
  assert.equal(alive(s.childPid!), false)
})

test('接管：pid 已被无关进程复用 → 视为已退出，不向该进程发任何信号', async (t) => {
  const sb = new Sandbox()
  const unrelated = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  t.after(() => { cleanupGroup(unrelated.pid!); sb.cleanup() })
  await new Promise((r) => setTimeout(r, 200))
  const h: Holder = { pid: unrelated.pid!, pgid: unrelated.pid!, token: 'tok-not-in-cmdline', startedAt: 0, kind: 'background' }
  assert.equal(await takeover(h, { force: true, staleMs: 0 }), 'gone')
  assert.equal(alive(unrelated.pid!), true, '无关进程没有收到信号')
})

test('接管：前台持有者（用户终端里的 git commit）从不发信号', async (t) => {
  const sb = new Sandbox()
  const s = await spawnHolder(sb)
  t.after(() => { cleanupGroup(s.holder.pid!); sb.cleanup() })
  assert.equal(await takeover(asHolder(s, { kind: 'foreground', pgid: null }), { force: true, staleMs: 0 }), 'alive')
  assert.ok(alive(s.holder.pid!))
  process.kill(s.holder.pid!, 'SIGKILL')
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(await takeover(asHolder(s, { kind: 'foreground', pgid: null }), { force: false, staleMs: 0 }), 'gone')
})

test('进程命令行完整读出：位于长命令行末尾的令牌不被截断', async (t) => {
  const token = `tok${'0'.repeat(8)}${Date.now()}`
  const filler = Array.from({ length: 40 }, (_, i) => `--padding-argument-${i}`)
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', ...filler, '--token', token], { stdio: 'ignore' })
  t.after(() => c.kill('SIGKILL'))
  await new Promise((r) => setTimeout(r, 200))
  const cmd = processCommand(c.pid!)
  assert.ok(cmd !== null && cmd.length > 300, `命令行长度 ${cmd?.length}`)
  assert.ok(cmd!.endsWith(token), '令牌位于末尾且完整')
  c.kill('SIGKILL')
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(processCommand(c.pid!), null, '进程退出后返回 null')
})

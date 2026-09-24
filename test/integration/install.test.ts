// 第 9 组：安装与卸载
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { Sandbox, type Repo } from '../helpers/repo.ts'
import { BUNDLE } from '../helpers/paths.ts'
import { COUNTER, installPrepareHook, lineCount, writeMachineConfig } from '../helpers/setup.ts'
import { parseOwnership } from '../../src/hook/templates.ts'

function cli(repo: Repo, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { cwd: repo.dir, env: repo.sandbox.env(env), encoding: 'utf8' })
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr }
}

function setup(t: { after: (fn: () => void) => void }) {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  writeMachineConfig(sb)
  return sb
}

const hookFile = (repo: Repo) => join(repo.gitPath('hooks'), 'prepare-commit-msg')

// ---------- 9.1 hooks 目录判定 ----------

test('9.1 两个无关仓库共用全局 core.hooksPath：不写入共享目录，另一个仓库不受影响', (t) => {
  const sb = setup(t)
  const shared = join(sb.root, 'shared-hooks')
  mkdirSync(shared)
  const a = sb.repo('a')
  const b = sb.repo('b')
  a.git(['config', '--global', 'core.hooksPath', shared])
  const r = cli(a, ['install'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /冲突：Git 实际使用的 hooks 目录是 .*shared-hooks/)
  assert.match(r.stderr, /core\.hooksPath=.*shared-hooks（file:/)
  assert.match(r.stderr, /hook prepare-commit-msg --install-id manual -- "\$@"/)
  assert.deepEqual(readdirSync(shared), [], '共享目录未被写入')
  const log = join(sb.root, 'fake.log')
  b.write('x.txt', 'x\n'); b.git(['add', '.'])
  b.git(['commit', '-q', '--allow-empty-message', '--no-edit'], { env: { FAKE_LOG: log } })
  assert.equal(lineCount(log), 0, 'B 的暂存与提交都没有启动模型')
})

test('9.1 hooks 目录被 Husky 接管：报告冲突，文件保持不变', (t) => {
  const sb = setup(t)
  const repo = sb.repo()
  const husky = repo.write('.husky/_/prepare-commit-msg', '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n')
  repo.git(['config', 'core.hooksPath', '.husky/_'])
  const before = readFileSync(husky, 'utf8')
  const r = cli(repo, ['install'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /冲突/)
  assert.equal(readFileSync(husky, 'utf8'), before)
  assert.equal(existsSync(join(repo.dir, '.git', 'hooks', 'prepare-commit-msg')), false)
})

test('9.1 默认目录中已有手写的同名 hook：报告冲突，文件保持不变', (t) => {
  const sb = setup(t)
  const repo = sb.repo()
  const f = hookFile(repo)
  writeFileSync(f, '#!/bin/sh\necho mine\n'); chmodSync(f, 0o755)
  const r = cli(repo, ['install'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /已存在且不是本工具写入的，未做任何修改/)
  assert.equal(readFileSync(f, 'utf8'), '#!/bin/sh\necho mine\n')
})

// ---------- 9.2 安装 ----------

test('9.2 安装：写入 hook，为每个 worktree 创建状态目录，并说明 hooks 由所有 worktree 共享', (t) => {
  const sb = setup(t)
  const repo = sb.repo()
  const wt = repo.addWorktree('wt')
  const r = cli(repo, ['install'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /该 hooks 目录由本仓库的所有 worktree 共享/)
  const own = parseOwnership(readFileSync(hookFile(repo), 'utf8'))!
  assert.equal(own.intact, true)
  for (const w of [repo, wt]) {
    const dir = join(w.gitPath('ai-commit'), own.installId)
    for (const sub of ['tasks', 'locks', 'cache']) assert.ok(existsSync(join(dir, sub)), `${w.dir}: ${sub}`)
  }
  assert.match(wt.gitPath('ai-commit'), /worktrees\/wt\/ai-commit$/)
})

test('9.2 重复安装：结果与安装一次相同', (t) => {
  const sb = setup(t)
  const repo = sb.repo()
  cli(repo, ['install'])
  const first = readFileSync(hookFile(repo), 'utf8')
  assert.equal(cli(repo, ['install']).status, 0)
  assert.equal(readFileSync(hookFile(repo), 'utf8'), first)
})

test('9.2 hook 被用户改过后再次安装：不覆盖并报告', (t) => {
  const sb = setup(t)
  const repo = sb.repo()
  cli(repo, ['install'])
  const f = hookFile(repo)
  const modified = readFileSync(f, 'utf8') + 'echo "my addition"\n'
  writeFileSync(f, modified)
  const r = cli(repo, ['install'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /在安装后被修改过，未覆盖/)
  assert.equal(readFileSync(f, 'utf8'), modified)
})

// ---------- 9.3 卸载 ----------

test('9.3 卸载：移除 hook 与所有 worktree 的状态目录；再次卸载不报错', (t) => {
  const sb = setup(t)
  const repo = sb.repo()
  const wt = repo.addWorktree('wt')
  cli(repo, ['install'])
  const r = cli(wt, ['uninstall'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(existsSync(hookFile(repo)), false)
  for (const w of [repo, wt]) assert.equal(existsSync(w.gitPath('ai-commit')), false, w.dir)
  const again = cli(repo, ['uninstall'])
  assert.equal(again.status, 0)
  assert.match(again.stdout, /未安装/)
})

test('9.3 hook 被用户改过：卸载时保留并报告', (t) => {
  const sb = setup(t)
  const repo = sb.repo()
  cli(repo, ['install'])
  const f = hookFile(repo)
  writeFileSync(f, readFileSync(f, 'utf8') + '# my change\n')
  const r = cli(repo, ['uninstall'])
  assert.equal(r.status, 0)
  assert.ok(existsSync(f))
  assert.match(r.stderr, /被修改过，已保留/)
})

test('9.3 卸载时终止已登记的任务并确认退出', async (t) => {
  const sb = setup(t)
  const repo = sb.repo()
  cli(repo, ['install'])
  const own = parseOwnership(readFileSync(hookFile(repo), 'utf8'))!
  const token = `tok-${Date.now()}`
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)', token], { detached: true, stdio: 'ignore' })
  child.unref()
  const reg = join(repo.gitPath('ai-commit'), own.installId, 'tasks', `${token}.json`)
  writeFileSync(reg, JSON.stringify({ pid: child.pid, pgid: child.pid, token, phase: 'debounce' }))
  const r = cli(repo, ['uninstall'])
  assert.equal(r.status, 0, r.stderr)
  await sleep(200)
  assert.throws(() => process.kill(child.pid!, 0), '登记的任务已被终止')
})

// ---------- 9.4 GUI 环境 ----------

test('9.4 最小环境（env -i，PATH 中没有 node）：hook 仍能启动主程序', (t) => {
  const sb = setup(t)
  const repo = sb.repo()
  const count = join(sb.root, 'count.log')
  installPrepareHook(repo, { script: COUNTER })
  repo.write('x.txt', 'x\n'); repo.git(['add', '.'])
  const r = spawnSync('/usr/bin/env', ['-i', 'PATH=/usr/bin:/bin', `HOME=${sb.home}`, `GIT_CONFIG_GLOBAL=${sb.globalConfig}`, 'GIT_CONFIG_NOSYSTEM=1', `COUNTER_FILE=${count}`,
    'git', 'commit', '-q', '--allow-empty-message', '--no-edit'], { cwd: repo.dir, encoding: 'utf8' })
  assert.equal(spawnSync('/usr/bin/env', ['-i', 'PATH=/usr/bin:/bin', 'sh', '-c', 'command -v node'], { encoding: 'utf8' }).status, 1, '最小环境中确实找不到 node')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(lineCount(count), 1)
})

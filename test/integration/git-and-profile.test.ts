import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Sandbox } from '../helpers/repo.ts'
import { Git } from '../../src/git/git.ts'
import { loadMachineConfig } from '../../src/config/machine.ts'
import { resolveProfile } from '../../src/config/profile.ts'

// ---------- 3.1 git 子进程封装 ----------

test('相对的 GIT_INDEX_FILE 按启动目录解析：在子目录中运行仍指向正确的 index', (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const repo = sb.repo()
  // 准备一个与默认 index 内容不同的备用 index
  repo.write('only-in-alt.txt', 'alt\n')
  repo.git(['add', 'only-in-alt.txt'], { env: { GIT_INDEX_FILE: join(repo.dir, '.git', 'alt-index') } })
  const expected = repo.git(['write-tree'], { env: { GIT_INDEX_FILE: join(repo.dir, '.git', 'alt-index') } }).stdout.trim()
  const defaultTree = repo.git(['write-tree']).stdout.trim()
  assert.notEqual(expected, defaultTree)

  mkdirSync(join(repo.dir, 'sub', 'deeper'), { recursive: true })
  const git = new Git(repo.dir, sb.env({ GIT_INDEX_FILE: '.git/alt-index' }))
  assert.equal(git.env.GIT_INDEX_FILE, join(repo.dir, '.git', 'alt-index'))
  assert.equal(git.text(['write-tree'], { cwd: join(repo.dir, 'sub', 'deeper') }), expected)
})

test('所有 git 子进程都带重入标记与字面路径模式', (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const repo = sb.repo()
  const git = new Git(repo.dir, sb.env())
  const env = git.text(['-c', 'alias.envprobe=!env', 'envprobe'])
  assert.match(env, /^AI_COMMIT_ACTIVE=1$/m)
  assert.match(env, /^GIT_LITERAL_PATHSPECS=1$/m)
})

// ---------- 2.3 选择优先级（读取真实的各级来源）----------

test('各级来源逐级覆盖；用环境变量单次切换不修改任何配置文件', (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const repo = sb.repo()
  const cfgDir = join(sb.home, '.config', 'git-ai-commit')
  mkdirSync(cfgDir, { recursive: true })
  const cfgPath = join(cfgDir, 'config.json')
  const profiles = Object.fromEntries(['a', 'b', 'c', 'd'].map((n) => [n, { harness: 'claude', model: `m-${n}` }]))
  writeFileSync(cfgPath, JSON.stringify({ defaultProfile: 'd', profiles }))
  repo.git(['config', '--local', 'aicommit.profile', 'c'])

  const gitConfigPath = join(repo.dir, '.git', 'config')
  const before = { cfg: readFileSync(cfgPath, 'utf8'), cfgM: statSync(cfgPath).mtimeMs, git: readFileSync(gitConfigPath, 'utf8'), gitM: statSync(gitConfigPath).mtimeMs }

  const env = sb.env({ AI_COMMIT_PROFILE: 'b' })
  const machine = loadMachineConfig(env)
  assert.equal(machine.exists, true)
  const git = new Git(repo.dir, env)
  const pick = (flag: string | undefined, e: NodeJS.ProcessEnv) => {
    const r = resolveProfile({ flag, env: e, git, machine: machine.config })
    return r.ok ? `${r.profile.name}:${r.source}` : r.error
  }
  assert.equal(pick('a', env), 'a:flag')
  assert.equal(pick(undefined, env), 'b:env')
  assert.equal(pick(undefined, sb.env()), 'c:git')
  repo.git(['config', '--local', '--unset', 'aicommit.profile'])
  assert.equal(pick(undefined, sb.env()), 'd:default')
  repo.git(['config', '--local', 'aicommit.profile', 'c'])

  // 用环境变量切换一次：配置文件内容与修改时间都不变
  pick(undefined, env)
  assert.equal(readFileSync(cfgPath, 'utf8'), before.cfg)
  assert.equal(statSync(cfgPath).mtimeMs, before.cfgM)
  assert.match(readFileSync(gitConfigPath, 'utf8'), /profile = c/)
  assert.ok(before.git.includes('profile = c'))
})

test('profile 不存在或未配置时给出明确原因', (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const repo = sb.repo()
  const machine = loadMachineConfig(sb.env())
  assert.equal(machine.exists, false)
  const r1 = resolveProfile({ env: sb.env(), git: new Git(repo.dir, sb.env()), machine: machine.config })
  assert.equal(r1.ok, false)
  assert.match((r1 as { error: string }).error, /未配置 profile/)
  const r2 = resolveProfile({ env: sb.env({ AI_COMMIT_PROFILE: 'ghost' }), git: null, machine: machine.config })
  assert.match((r2 as { error: string }).error, /"ghost"（来自 AI_COMMIT_PROFILE）不存在/)
})

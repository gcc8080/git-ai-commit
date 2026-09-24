// 第 15 组：预热开关、执行时授权与 post-index-change 的 shell 过滤（D3、D15、D18）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Sandbox, type Repo } from '../helpers/repo.ts'
import { COUNTER, installPrepareHook, lineCount, writeMachineConfig } from '../helpers/setup.ts'
import { cli, calls, installWithPrewarm, sleep, stateOf, waitIdle } from '../helpers/prewarm.ts'
import { postIndexChangeTemplate } from '../../src/hook/templates.ts'
import { installCommand } from '../../src/commands/install.ts'

function setup(t: { after: (fn: () => void) => void }, name = 'repo') {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  writeMachineConfig(sb, { debounceMs: 300 })
  return sb.repo(name)
}

/** 写入真实模板生成的 post-index-change，主程序入口换成计数器。 */
function installCountingPrewarmHook(repo: Repo): string {
  const dir = repo.gitPath('hooks')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'post-index-change')
  writeFileSync(file, postIndexChangeTemplate({ node: process.execPath, script: COUNTER, installId: 'test' }))
  chmodSync(file, 0o755)
  return file
}

/** 计数器以后台方式启动：等它写完再数。 */
async function countAfter(file: string, action: () => void): Promise<number> {
  writeFileSync(file, '')
  action()
  await sleep(600)
  return lineCount(file)
}

// ---------- 15.2 入口计数 ----------

test('15.2 入口计数：预热关闭、跳过、重入、暂存为空时启动次数为零；有暂存变化时启动一次', async (t) => {
  const repo = setup(t)
  installCountingPrewarmHook(repo)
  const count = join(repo.sandbox.root, 'count.log')
  const env = { COUNTER_FILE: count }
  let n = 0
  const add = (extra: Record<string, string> = {}) => () => { repo.write(`f${n++}.txt`, `${n}\n`); repo.git(['add', '-A'], { env: { ...env, ...extra } }) }
  assert.equal(await countAfter(count, add()), 0, '预热未开启')
  repo.git(['config', 'aicommit.prewarm', 'false'])
  assert.equal(await countAfter(count, add()), 0, '预热显式关闭')
  repo.git(['config', 'aicommit.prewarm', 'true'])
  assert.equal(await countAfter(count, add({ AI_COMMIT_SKIP: '1' })), 0, '跳过开关')
  assert.equal(await countAfter(count, add({ AI_COMMIT_ACTIVE: '1' })), 0, '重入标记')
  assert.equal(await countAfter(count, add()), 1, '有暂存变化')
  const rec = JSON.parse(readFileSync(count, 'utf8').trim()) as { argv: string[] }
  assert.deepEqual(rec.argv, ['warm', '--install-id', 'test'])
  repo.git(['commit', '-q', '-m', 'x'], { env: { AI_COMMIT_SKIP: '1' } })
  assert.equal(await countAfter(count, () => { repo.write('README.md', '# fixture\n'); repo.git(['status', '--short'], { env }) }), 0, '暂存为空时刷新 stat')
})

test('15.2 入口计数：仓库尚无提交、处于特殊流程时启动次数为零', async (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const fresh = sb.repo('fresh', { initialCommit: false })
  installCountingPrewarmHook(fresh)
  fresh.git(['config', 'aicommit.prewarm', 'true'])
  const count = join(sb.root, 'count.log')
  assert.equal(await countAfter(count, () => { fresh.write('a.txt', 'a\n'); fresh.git(['add', 'a.txt'], { env: { COUNTER_FILE: count } }) }), 0, '没有 HEAD（首次提交）')

  const repo = sb.repo('merge repo')
  installCountingPrewarmHook(repo)
  repo.git(['config', 'aicommit.prewarm', 'true'])
  repo.write('c.txt', 'base\n'); repo.git(['add', '.']); repo.git(['commit', '-q', '-m', 'base'], { env: { AI_COMMIT_SKIP: '1' } })
  repo.git(['checkout', '-q', '-b', 'side'])
  repo.write('c.txt', 'side\n'); repo.git(['commit', '-q', '-am', 'side'], { env: { AI_COMMIT_SKIP: '1' } })
  repo.git(['checkout', '-q', 'main'])
  repo.write('c.txt', 'main\n'); repo.git(['commit', '-q', '-am', 'main'], { env: { AI_COMMIT_SKIP: '1' } })
  repo.git(['merge', 'side'], { allowFail: true, env: { AI_COMMIT_SKIP: '1' } })
  assert.ok(existsSync(repo.gitPath('MERGE_HEAD')), '处于合并流程')
  assert.equal(await countAfter(count, () => { repo.write('c.txt', 'resolved\n'); repo.git(['add', 'c.txt'], { env: { COUNTER_FILE: count } }) }), 0, '合并流程中（仓库路径含空格）')
})

test('15.2 linked worktree（路径含空格）中的特殊流程同样识别', async (t) => {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const repo = sb.repo('main repo')
  installCountingPrewarmHook(repo)
  repo.git(['config', 'aicommit.prewarm', 'true'])
  const wt = repo.addWorktree('linked wt', 'feature')
  const count = join(sb.root, 'count.log')
  assert.equal(await countAfter(count, () => { wt.write('w.txt', 'w\n'); wt.git(['add', 'w.txt'], { env: { COUNTER_FILE: count } }) }), 1, 'linked worktree 中正常触发')
  writeFileSync(wt.gitPath('CHERRY_PICK_HEAD'), `${wt.git(['rev-parse', 'HEAD']).stdout.trim()}\n`)
  assert.equal(await countAfter(count, () => { wt.write('w.txt', 'w2\n'); wt.git(['add', 'w.txt'], { env: { COUNTER_FILE: count } }) }), 0, 'linked worktree 的 CHERRY_PICK_HEAD 是含空格的绝对路径')
})

test('15.2 配置了 textconv 与外部 diff 时：外部程序调用次数为零，且能识别出变化', async (t) => {
  const repo = setup(t)
  installCountingPrewarmHook(repo)
  repo.git(['config', 'aicommit.prewarm', 'true'])
  const log = join(repo.sandbox.root, 'external.log')
  const conv = repo.write('../conv.sh', `#!/bin/sh\necho textconv >> '${log}'\necho same\n`)
  const ext = repo.write('../ext.sh', `#!/bin/sh\necho external >> '${log}'\n`)
  chmodSync(conv, 0o755); chmodSync(ext, 0o755)
  repo.git(['config', 'diff.conv.textconv', conv])
  repo.git(['config', 'diff.external', ext])
  repo.write('.gitattributes', '*.dat diff=conv\n')
  repo.write('x.dat', 'v1\n'); repo.git(['add', '.']); repo.git(['commit', '-q', '-m', 'v1'], { env: { AI_COMMIT_SKIP: '1' } })
  const count = join(repo.sandbox.root, 'count.log')
  assert.equal(await countAfter(count, () => { repo.write('x.dat', 'v2\n'); repo.git(['add', 'x.dat'], { env: { COUNTER_FILE: count } }) }), 1, 'textconv 把两侧转换成同一行，仍识别出变化')
  assert.equal(existsSync(log), false, '外部程序调用次数为零')
})

// ---------- 15.1 prewarm on|off 与 install ----------

test('15.1 prewarm on|off：需要先安装；开启时说明外发不可撤回；关闭只移除 post-index-change', (t) => {
  const repo = setup(t)
  const hooks = repo.gitPath('hooks')
  assert.equal(cli(repo, ['prewarm', 'on']).status, 1, '未安装时拒绝开启')
  const inst = cli(repo, ['install'])
  assert.equal(inst.status, 0, inst.stderr)
  assert.match(inst.stdout, /预热未开启（默认关闭）/, '非交互环境保持关闭')
  assert.equal(existsSync(join(hooks, 'post-index-change')), false)

  const on = cli(repo, ['prewarm', 'on'])
  assert.equal(on.status, 0, on.stderr)
  assert.match(on.stdout, /撤不回已发出的请求/)
  assert.equal(repo.git(['config', '--local', 'aicommit.prewarm']).stdout.trim(), 'true')
  assert.ok(existsSync(join(hooks, 'post-index-change')))

  const id = readFileSync(join(hooks, 'prepare-commit-msg'), 'utf8').match(/install-id=(\S+)/)![1]!
  const cacheMarker = join(stateOf(repo, id).cache, 'keep.json')
  writeFileSync(cacheMarker, '{}')
  const off = cli(repo, ['prewarm', 'off'])
  assert.equal(off.status, 0, off.stderr)
  assert.equal(repo.git(['config', '--local', 'aicommit.prewarm']).stdout.trim(), 'false')
  assert.equal(existsSync(join(hooks, 'post-index-change')), false)
  assert.ok(existsSync(join(hooks, 'prepare-commit-msg')), 'prepare-commit-msg 仍在')
  assert.ok(existsSync(cacheMarker), '缓存仍在')
})

test('15.1 卸载后 aicommit.prewarm 保持原值；重新安装时说明将直接启用预热', (t) => {
  const repo = setup(t)
  installWithPrewarm(repo)
  assert.equal(cli(repo, ['uninstall']).status, 0)
  assert.equal(repo.git(['config', '--local', 'aicommit.prewarm']).stdout.trim(), 'true')
  assert.equal(existsSync(join(repo.gitPath('hooks'), 'post-index-change')), false)
  const again = cli(repo, ['install'])
  assert.match(again.stdout, /直接启用预热/)
  assert.ok(existsSync(join(repo.gitPath('hooks'), 'post-index-change')))
})

test('15.1 install 在该项未设置时交互式询问一次', async (t) => {
  for (const answer of [true, false]) {
    const repo = setup(t, `ask-${answer}`)
    const out: string[] = []
    const io = { out: (s: string) => { out.push(s) }, err: (s: string) => { out.push(s) } }
    let asked = 0
    const code = await installCommand({ kind: 'install' }, io, repo.sandbox.env(), { node: process.execPath, script: '/x/dist/git-ai-commit.js' }, async () => { asked++; return answer }, repo.dir)
    assert.equal(code, 0, out.join('\n'))
    assert.equal(asked, 1)
    assert.equal(repo.git(['config', '--local', 'aicommit.prewarm']).stdout.trim(), String(answer))
    assert.equal(existsSync(join(repo.gitPath('hooks'), 'post-index-change')), answer)
    // 再次安装不再询问
    await installCommand({ kind: 'install' }, io, repo.sandbox.env(), { node: process.execPath, script: '/x/dist/git-ai-commit.js' }, async () => { asked++; return answer }, repo.dir)
    assert.equal(asked, 1)
  }
})

// ---------- 15.3 执行时授权 ----------

test('15.3 开启并安装后直接把 aicommit.prewarm 改为 false：随后的暂存不启动任何请求', async (t) => {
  const repo = setup(t)
  installPrepareHook(repo)
  const id = installWithPrewarm(repo)
  repo.git(['config', 'aicommit.prewarm', 'false'])
  const log = join(repo.sandbox.root, 'fake.jsonl')
  repo.write('a.txt', 'a\n')
  repo.git(['add', 'a.txt'], { env: { FAKE_LOG: log } })
  await waitIdle(id)
  assert.equal(calls(log).length, 0)
})

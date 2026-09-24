// 第 4 组：来源判断、注释与 scissors、正文白名单、写入
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Sandbox, type Repo } from '../helpers/repo.ts'
import { writeNodeHook } from '../helpers/hooks.ts'
import { FIXTURES } from '../helpers/paths.ts'
import { scissorsLine } from '../../src/git/msgfile.ts'

const PROBE = join(FIXTURES, 'prepare-probe.ts')
const MSG = 'feat(demo): 生成的标题\n\n- 生成的正文'

function setup(t: { after: (fn: () => void) => void }) {
  const sb = new Sandbox()
  t.after(() => sb.cleanup())
  const repo = sb.repo()
  writeNodeHook(repo, 'prepare-commit-msg', PROBE)
  return repo
}

function stage(repo: Repo, name = 'x.txt', content = `${Math.random()}\n`) {
  repo.write(name, content)
  repo.git(['add', name])
}

function commit(repo: Repo, args: string[], env: Record<string, string> = {}) {
  const log = join(repo.sandbox.root, `gen-${Math.random().toString(36).slice(2)}.log`)
  const r = repo.git(['commit', '-q', ...args], { env: { PROBE_GEN_LOG: log, PROBE_MESSAGE: MSG, ...env }, allowFail: true })
  const gens = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0
  return { r, gens, message: repo.git(['log', '-1', '--format=%B']).stdout }
}

// ---------- 4.1 来源判断 ----------

test('4.1 显式消息、重用消息、fixup/squash：生成步骤调用次数都为零', (t) => {
  const repo = setup(t)
  const cases: Array<[string, string[]]> = [
    ['-m', ['-m', 'manual']],
    ['-F', ['-F', repo.write('../msg.txt', 'from file\n')]],
    ['--amend', ['--amend', '--no-edit']],
    ['-c', ['-c', 'HEAD']],
    ['-C', ['-C', 'HEAD']],
    ['--fixup', ['--fixup', 'HEAD']],
    ['--squash', ['--squash', 'HEAD', '-m', 'sq']],
  ]
  for (const [name, args] of cases) {
    stage(repo)
    const { r, gens } = commit(repo, args)
    assert.equal(r.status, 0, `${name}: ${r.stderr}`)
    assert.equal(gens, 0, `${name} 不应调用生成`)
  }
  assert.match(repo.git(['log', '-3', '--format=%s']).stdout, /^squash! /m)
})

test('4.1 无消息的普通提交会进入生成', (t) => {
  const repo = setup(t)
  stage(repo)
  const { gens, message } = commit(repo, [])
  assert.equal(gens, 1)
  assert.equal(message.trim(), MSG)
})

// ---------- 4.2 注释与 scissors ----------

test('4.2 git commit -v / -vv：scissors 以下内容保持不变，最终消息只含插入的内容', (t) => {
  const repo = setup(t)
  for (const flag of ['-v', '-vv']) {
    stage(repo)
    repo.write('unstaged.txt', `${Math.random()}\n`)
    const before = join(repo.sandbox.root, 'before.txt')
    const after = join(repo.sandbox.root, 'after.txt')
    const { gens, message } = commit(repo, [flag], { PROBE_BEFORE: before, PROBE_AFTER: after })
    assert.equal(gens, 1)
    const cut = (s: string) => s.slice(s.indexOf(scissorsLine('#')))
    const b = readFileSync(before, 'utf8')
    assert.ok(b.includes(scissorsLine('#')), `${flag} 的消息文件含 scissors`)
    assert.equal(cut(readFileSync(after, 'utf8')), cut(b), `${flag}：scissors 以下未被改动`)
    assert.equal(message.trim(), MSG)
  }
})

test('4.2 core.commentChar=auto：消息文件保持原样', (t) => {
  const repo = setup(t)
  repo.git(['config', 'core.commentChar', 'auto'])
  stage(repo)
  const before = join(repo.sandbox.root, 'before.txt')
  const after = join(repo.sandbox.root, 'after.txt')
  const { gens } = commit(repo, ['--allow-empty-message'], { PROBE_BEFORE: before, PROBE_AFTER: after })
  assert.equal(gens, 0)
  assert.equal(readFileSync(after, 'utf8'), readFileSync(before, 'utf8'))
})

// ---------- 4.3 正文白名单 ----------

test('4.3 空模板、纯注释模板、只有签名行：需要生成', (t) => {
  const repo = setup(t)
  const empty = repo.write('../empty.tmpl', '')
  const comments = repo.write('../comments.tmpl', '# 只有注释\n# 第二行\n')
  const cases: Array<[string, string[], Record<string, string>]> = [
    ['空模板（全局 commit.template）', [], {}],
    ['纯注释模板', ['-t', comments], {}],
    ['只有签名行', ['-s'], {}],
  ]
  repo.git(['config', '--global', 'commit.template', empty])
  for (const [name, args] of cases) {
    stage(repo)
    const { r, gens, message } = commit(repo, args)
    assert.equal(r.status, 0, `${name}: ${r.stderr}`)
    assert.equal(gens, 1, `${name} 应调用生成`)
    assert.ok(message.startsWith('feat(demo): 生成的标题'), name)
  }
})

test('4.3 模板含冒号行或有 --trailer 尾注：保留原样，生成步骤调用次数为零', (t) => {
  const repo = setup(t)
  const cases: Array<[string, string]> = [
    ['fix: 标题', 'fix: preserve my intended message\n'],
    ['feat: 标题', 'feat: 已有标题\n'],
    ['说明: 冒号行', '说明: 预设文字\n'],
    ['Co-authored-by 尾注', '\nCo-authored-by: A <a@example.com>\n'],
  ]
  for (const [name, content] of cases) {
    const tmpl = repo.write(`../t-${Math.random().toString(36).slice(2)}.tmpl`, content)
    stage(repo)
    // 模板未被编辑时 Git 自己会中止；这里只关心生成步骤是否被调用
    const { gens } = commit(repo, ['-t', tmpl])
    assert.equal(gens, 0, name)
  }
  stage(repo)
  const { gens } = commit(repo, ['--trailer', 'Reviewed-by: A <a@example.com>'])
  assert.equal(gens, 0, '--trailer')
})

// ---------- 4.4 写入 ----------

test('4.4 -s：最终消息为 标题 + 空行 + Signed-off-by', (t) => {
  const repo = setup(t)
  stage(repo)
  const { message } = commit(repo, ['-s'])
  assert.equal(message.trimEnd(), `${MSG}\n\nSigned-off-by: Test User <test@example.com>`)
})

test('4.4 --no-edit：生成的消息被直接提交', (t) => {
  const repo = setup(t)
  stage(repo)
  const { r, message } = commit(repo, ['--no-edit'])
  assert.equal(r.status, 0)
  assert.equal(message.trim(), MSG)
})

test('4.4 生成失败：消息文件不变，以 0 退出，由 Git 原生规则决定（空消息被 Git 中止）', (t) => {
  const repo = setup(t)
  stage(repo)
  const head = repo.git(['rev-parse', 'HEAD']).stdout
  const { r, gens } = commit(repo, ['--no-edit'], { PROBE_MESSAGE: '' })
  assert.equal(gens, 1)
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /ai-commit: 生成失败，保留原消息/)
  assert.match(r.stderr, /Aborting commit due to empty commit message/)
  assert.equal(repo.git(['rev-parse', 'HEAD']).stdout, head)
})

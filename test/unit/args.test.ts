import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand, UsageError } from '../../src/cli/args.ts'
import { main, type Io } from '../../src/main.ts'

test('无参数与 --help 解析为 help', () => {
  assert.deepEqual(parseCommand([]), { kind: 'help' })
  assert.deepEqual(parseCommand(['--help']), { kind: 'help' })
  assert.deepEqual(parseCommand(['help']), { kind: 'help' })
})

test('--version', () => {
  assert.deepEqual(parseCommand(['--version']), { kind: 'version' })
})

test('install / uninstall 不接受参数', () => {
  assert.deepEqual(parseCommand(['install']), { kind: 'install' })
  assert.deepEqual(parseCommand(['uninstall']), { kind: 'uninstall' })
  assert.throws(() => parseCommand(['install', 'x']), UsageError)
  assert.throws(() => parseCommand(['uninstall', '--force']), UsageError)
})

test('prewarm on|off', () => {
  assert.deepEqual(parseCommand(['prewarm', 'on']), { kind: 'prewarm', enable: true })
  assert.deepEqual(parseCommand(['prewarm', 'off']), { kind: 'prewarm', enable: false })
  assert.throws(() => parseCommand(['prewarm']), UsageError)
  assert.throws(() => parseCommand(['prewarm', 'maybe']), UsageError)
})

test('doctor 与 preview 的选项', () => {
  assert.deepEqual(parseCommand(['doctor']), { kind: 'doctor', profile: undefined })
  assert.deepEqual(parseCommand(['doctor', '--profile', 'fast']), { kind: 'doctor', profile: 'fast' })
  assert.deepEqual(parseCommand(['preview']), { kind: 'preview', profile: undefined, refresh: false })
  assert.deepEqual(parseCommand(['preview', '--refresh', '--profile=p1']), { kind: 'preview', profile: 'p1', refresh: true })
  assert.throws(() => parseCommand(['preview', '--unknown']), UsageError)
})

test('hook prepare-commit-msg：选项与 -- 之后的位置参数', () => {
  assert.deepEqual(
    parseCommand(['hook', 'prepare-commit-msg', '--install-id', 'abc', '--', '.git/COMMIT_EDITMSG', 'template']),
    { kind: 'hook', name: 'prepare-commit-msg', installId: 'abc', args: ['.git/COMMIT_EDITMSG', 'template'] },
  )
  // 消息文件路径以 - 开头时，放在 -- 之后也不会被当作选项
  assert.deepEqual(
    parseCommand(['hook', 'prepare-commit-msg', '--install-id', 'abc', '--', '-weird']).kind === 'hook',
    true,
  )
  assert.throws(() => parseCommand(['hook', 'prepare-commit-msg', '--', 'f']), UsageError)
  assert.throws(() => parseCommand(['hook', 'post-commit', '--install-id', 'a']), UsageError)
  assert.throws(() => parseCommand(['hook']), UsageError)
})

test('warm 后台入口', () => {
  assert.deepEqual(
    parseCommand(['warm', '--install-id', 'abc', '--detach']),
    { kind: 'warm', installId: 'abc', detach: true, token: undefined },
  )
  assert.deepEqual(
    parseCommand(['warm', '--install-id', 'abc', '--token', 't1']),
    { kind: 'warm', installId: 'abc', detach: false, token: 't1' },
  )
  assert.throws(() => parseCommand(['warm']), UsageError)
})

test('未知子命令：非零退出并打印用法', async () => {
  const errs: string[] = []
  const io: Io = { out: () => {}, err: (t) => errs.push(t) }
  const code = await main(['frobnicate'], io)
  assert.equal(code, 2)
  assert.match(errs.join(''), /未知命令：frobnicate/)
  assert.match(errs.join(''), /用法：git ai-commit/)
})

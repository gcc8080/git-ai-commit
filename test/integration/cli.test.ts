import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { BUNDLE } from '../helpers/paths.ts'

test('打包产物：未知子命令以非零退出并打印用法', () => {
  const r = spawnSync(process.execPath, [BUNDLE, 'nope'], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /未知命令：nope/)
  assert.match(r.stderr, /用法：git ai-commit/)
})

test('打包产物：--version 与 --help', () => {
  const v = spawnSync(process.execPath, [BUNDLE, '--version'], { encoding: 'utf8' })
  assert.equal(v.status, 0)
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+/)
  const h = spawnSync(process.execPath, [BUNDLE, '--help'], { encoding: 'utf8' })
  assert.equal(h.status, 0)
  assert.match(h.stdout, /用法：git ai-commit/)
})

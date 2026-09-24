import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchPath } from '../../src/util/glob.ts'
import { truncateAtLine } from '../../src/input/budget.ts'

const cases: Array<[string, string, boolean]> = [
  ['.env', '.env', true],
  ['config/.env', '.env', true],
  ['config/.env.local', '.env.*', true],
  ['prod.env', '*.env', true],
  ['.env', '*.env', true],
  ['environment.ts', '.env', false],
  ['keys/server.pem', '*.pem', true],
  ['a/b/c/Podfile.lock', 'Podfile.lock', true],
  ['apps/android/src/Main.kt', 'apps/android/**', true],
  ['apps/ios/Main.swift', 'apps/android/**', false],
  ['lib/gen/x.g.dart', '*.g.dart', true],
  ['src/a.ts', 'src/*.ts', true],
  ['src/sub/a.ts', 'src/*.ts', false],
  ['src/sub/a.ts', 'src/**/*.ts', true],
  ['src/a.ts', 'src/**/*.ts', true],
  ['/abs', '/abs', true],
  ['file[1].txt', 'file[0-9].txt', false],
  ['file1.txt', 'file[0-9].txt', true],
  ['filex.txt', 'file[!0-9].txt', true],
  ['a+b.txt', 'a+b.txt', true],
  ['aab.txt', 'a+b.txt', false],
]
for (const [path, pattern, expected] of cases) {
  test(`matchPath(${JSON.stringify(path)}, ${JSON.stringify(pattern)}) = ${expected}`, () => {
    assert.equal(matchPath(path, pattern), expected)
  })
}

test('按行截断：不超过字节上限，并统计被省略的行', () => {
  const text = 'line1\nline2\nline3\nline4\n'
  assert.deepEqual(truncateAtLine(text, 100), { kept: text, omittedLines: 0 })
  assert.deepEqual(truncateAtLine(text, 12), { kept: 'line1\nline2\n', omittedLines: 2 })
  assert.deepEqual(truncateAtLine(text, 3), { kept: '', omittedLines: 4 })
  assert.equal(Buffer.byteLength(truncateAtLine('中文\n中文\n', 8).kept), 7)
})

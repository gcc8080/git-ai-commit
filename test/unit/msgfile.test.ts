import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeMessage, insertMessage, scissorsLine } from '../../src/git/msgfile.ts'

const COMMENTS = '\n# Please enter the commit message for your changes.\n#\n# On branch main\n'

const needsGeneration: Array<[string, string]> = [
  ['空文件', ''],
  ['只有注释', COMMENTS],
  ['只有签名行', '\nSigned-off-by: Test User <test@example.com>\n' + COMMENTS],
  ['签名行 + scissors 以下有 diff', `\n${scissorsLine('#')}\n# Do not modify\ndiff --git a/x b/x\n+fix: looks like a title\n`],
]
for (const [name, content] of needsGeneration) {
  test(`无用户正文：${name}`, () => assert.equal(analyzeMessage(content, '#').hasUserContent, false))
}

const hasContent: Array<[string, string]> = [
  ['conventional 标题 fix:', 'fix: preserve my intended message\n' + COMMENTS],
  ['conventional 标题 feat:', 'feat: 新功能\n'],
  ['中文冒号行', '说明: 这是模板里的预设文字\n'],
  ['Co-authored-by 尾注', '\nCo-authored-by: A <a@example.com>\n'],
  ['--trailer 追加的尾注', '\nReviewed-by: A <a@example.com>\n' + COMMENTS],
  ['签名行格式不完整', 'Signed-off-by: someone\n'],
  ['普通文字', 'hello\n'],
]
for (const [name, content] of hasContent) {
  test(`已有用户正文：${name}`, () => assert.equal(analyzeMessage(content, '#').hasUserContent, true))
}

test('自定义注释字符', () => {
  assert.equal(analyzeMessage('; comment\n;another\n', ';').hasUserContent, false)
  assert.equal(analyzeMessage('# not a comment here\n', ';').hasUserContent, true)
})

test('插入到最前面并保留原有内容', () => {
  assert.equal(insertMessage('', 'feat: x'), 'feat: x\n')
  assert.equal(insertMessage('\nSigned-off-by: A <a@b>\n', 'feat: x'), 'feat: x\n\nSigned-off-by: A <a@b>\n')
  assert.equal(insertMessage('# comment\n', 'feat: x\n\n- a\n'), 'feat: x\n\n- a\n\n# comment\n')
})

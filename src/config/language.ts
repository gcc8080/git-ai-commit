// 提交信息的语言：给模型的语言名称，以及本地能机械检查的文字系统（commit-generation：按配置强制语言）。
export function languageName(code: string): string {
  const c = code.toLowerCase()
  if (c === 'zh' || c === 'zh-cn' || c === 'zh-hans') return '简体中文'
  if (c === 'zh-tw' || c === 'zh-hant') return '繁體中文'
  if (c === 'en' || c.startsWith('en-')) return 'English'
  if (c === 'ja' || c === 'ja-jp') return '日本語'
  return code
}

/**
 * 能可靠判定的语言对应的文字系统：中文要求含汉字，日文要求含假名或汉字。
 * 英文等使用拉丁字母的语言无法与夹带的代码标识符区分，不做机械检查。
 */
export function requiredScript(code: string): RegExp | null {
  const c = code.toLowerCase()
  if (c === 'zh' || c.startsWith('zh-')) return /\p{Script=Han}/u
  if (c === 'ja' || c.startsWith('ja-')) return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u
  return null
}

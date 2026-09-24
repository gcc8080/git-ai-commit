// 兜底解析（D6）：只允许剥掉最外层的代码围栏，剥掉后必须是完整、合法的 JSON；不做任何修补。
export type ParseJson = { ok: true; value: unknown } | { ok: false; error: string }

export function parseJsonText(text: string): ParseJson {
  let t = text.trim()
  if (t === '') return { ok: false, error: '输出为空' }
  if (t.startsWith('```')) {
    const m = /^```[A-Za-z0-9_-]*\n([\s\S]*?)\n?```$/.exec(t)
    if (!m) return { ok: false, error: '代码围栏不完整' }
    t = m[1]!.trim()
  }
  if (!t.startsWith('{')) return { ok: false, error: '输出不是 JSON 对象（可能夹带了说明文字）' }
  try {
    return { ok: true, value: JSON.parse(t) }
  } catch (err) {
    return { ok: false, error: `不是完整合法的 JSON：${(err as Error).message}` }
  }
}

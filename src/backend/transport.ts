// 传输层解析（D7）：各后端的 stdout 不是同一种格式，先按各自的传输层取出最终结果，再交给统一的校验。
// 非零退出、明确的错误事件、截断、空结果、缺少完成标记一律判为失败。
import type { BackendOutput, Failure, FailureClass } from './types.ts'
import { classifyText, describe } from './classify.ts'

export type TransportResult = { ok: true; output: BackendOutput } | { ok: false; failure: Failure }

const fail = (backend: string, cls: FailureClass, detail?: string): TransportResult => ({
  ok: false,
  failure: { class: cls, message: detail ? `${describe(backend, cls)}（${detail}）` : describe(backend, cls) },
})

/** claude --output-format json：单个 result envelope。完成标记为 type=result、subtype=success、is_error=false。 */
export function parseEnvelope(backend: string, stdout: string): TransportResult {
  let env: unknown
  try {
    env = JSON.parse(stdout.trim())
  } catch {
    return fail(backend, 'unknown', stdout.trim() === '' ? '没有输出' : '输出被截断或不是 JSON envelope')
  }
  if (typeof env !== 'object' || env === null || (env as { type?: unknown }).type !== 'result') {
    return fail(backend, 'unknown', '缺少 result envelope')
  }
  const e = env as Record<string, unknown>
  if (e.is_error === true || e.subtype !== 'success') {
    const status = typeof e.api_error_status === 'number' ? e.api_error_status : null
    let cls: FailureClass
    if (status === 429) cls = classifyText(String(e.result ?? '')) === 'quota' ? 'quota' : 'rate-limit'
    else if (status === 401 || status === 403) cls = 'auth'
    else if (status !== null && status >= 500) cls = 'unavailable'
    else cls = classifyText(String(e.result ?? ''))
    return fail(backend, cls)
  }
  if (typeof e.structured_output === 'object' && e.structured_output !== null) {
    return { ok: true, output: { kind: 'json', value: e.structured_output } }
  }
  if (typeof e.result === 'string' && e.result.trim() !== '') return { ok: true, output: { kind: 'text', text: e.result } }
  return fail(backend, 'unknown', '结果为空')
}

/** codex -o <file>：最后一条消息写在文件里，不从日志中拼接。 */
export function parseFileOutput(backend: string, content: string | null): TransportResult {
  if (content === null) return fail(backend, 'unknown', '没有写出结果文件')
  if (content.trim() === '') return fail(backend, 'unknown', '结果为空')
  return { ok: true, output: { kind: 'text', text: content } }
}

/** pi --mode text：stdout 即结果。 */
export function parseTextOutput(backend: string, stdout: string): TransportResult {
  if (stdout.trim() === '') return fail(backend, 'unknown', '结果为空')
  return { ok: true, output: { kind: 'text', text: stdout } }
}

/** opencode --format json：JSONL 事件流。取最后一条 text 事件；必须看到正常结束的 step_finish；错误事件即失败。 */
export function parseJsonl(backend: string, stdout: string): TransportResult & { sessionId: string | null; errorEvent: boolean } {
  let lastText: string | null = null
  let finished = false
  let sessionId: string | null = null
  const lines = stdout.split('\n').filter((l) => l.trim() !== '')
  for (const line of lines) {
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(line) as Record<string, unknown>
    } catch {
      return { ...fail(backend, 'unknown', '事件流被截断'), sessionId, errorEvent: false }
    }
    if (typeof ev.sessionID === 'string') sessionId = ev.sessionID
    const part = (ev.part ?? {}) as Record<string, unknown>
    if (ev.type === 'error') {
      const err = (ev.error ?? {}) as { name?: unknown; message?: unknown; data?: { message?: unknown; statusCode?: unknown } }
      const text = [err.name, err.message, err.data?.message, err.data?.statusCode].filter((x) => x !== undefined).join(' ')
      return { ...fail(backend, classifyText(text)), sessionId, errorEvent: true }
    }
    if (ev.type === 'text' && typeof part.text === 'string') lastText = part.text
    if (ev.type === 'step_finish' && part.reason === 'stop') finished = true
  }
  if (!finished) return { ...fail(backend, 'unknown', '事件流缺少完成标记'), sessionId, errorEvent: false }
  if (lastText === null || lastText.trim() === '') return { ...fail(backend, 'unknown', '结果为空'), sessionId, errorEvent: false }
  return { ok: true, output: { kind: 'text', text: lastText }, sessionId, errorEvent: false }
}

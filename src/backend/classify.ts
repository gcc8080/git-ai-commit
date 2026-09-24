// 失败分类（D8）：给用户的只有分类后的一行固定文案，绝不引用后端的 stderr（其中可能回显了完整的 diff）。
import type { Failure, FailureClass } from './types.ts'
import type { ExecResult } from './exec.ts'

export const FAILURE_LABEL: Record<FailureClass, string> = {
  quota: '额度已耗尽',
  'rate-limit': '请求过于频繁（被限流）',
  network: '网络错误',
  unavailable: '服务暂时不可用',
  timeout: '超时',
  auth: '未登录或认证已失效，请在该 CLI 中重新登录',
  config: '配置错误',
  incompatible: 'CLI 版本不兼容（缺少必需的参数）',
  'invalid-output': '输出不合规',
  refusal: '模型认为证据不足，拒绝生成',
  cancelled: '已取消',
  unknown: '调用失败',
}

/** 允许回退的失败类别（D8）。 */
export const FALLBACK_ELIGIBLE: ReadonlySet<FailureClass> = new Set(['quota', 'rate-limit', 'network', 'unavailable', 'timeout', 'auth'])

const PATTERNS: Array<[FailureClass, RegExp]> = [
  ['quota', /usage limit|quota|insufficient[_ ]credit|credit balance|billing|exceeded your current/i],
  ['rate-limit', /rate[ _-]?limit|too many requests|\b429\b/i],
  ['auth', /not logged in|unauthori[sz]ed|\b401\b|\b403\b|please (run )?\/?login|authentication|invalid api key|expired token|oauth/i],
  ['incompatible', /unknown option|unexpected argument|unrecognized (option|argument)|invalid option|unknown flag/i],
  ['config', /model[^\n]{0,40}(not found|does not exist|not supported)|invalid model|unknown model|unknown provider|no such model/i],
  ['network', /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network error|fetch failed|getaddrinfo|socket hang up/i],
  ['unavailable', /overloaded|service unavailable|\b50[234]\b|internal server error|temporarily unavailable/i],
]

export function classifyText(text: string): FailureClass {
  for (const [cls, re] of PATTERNS) if (re.test(text)) return cls
  return 'unknown'
}

/** 取 stdout 与 stderr 各自的末尾若干行，避免后端回显的 prompt（含 diff）干扰分类。 */
export function tailText(r: ExecResult, lines = 15): string {
  const tail = (s: string) => s.split('\n').slice(-lines).join('\n')
  return `${tail(r.stderr)}\n${tail(r.stdout)}`
}

export function describe(backend: string, cls: FailureClass): string {
  return `${backend}：${FAILURE_LABEL[cls]}`
}

/** 执行层面的失败（无法启动、超时、取消、非零退出）；执行成功时返回 null。 */
export function execFailure(backend: string, command: string, r: ExecResult, text: string = tailText(r)): Failure | null {
  if (r.spawnError !== null) {
    return r.spawnError === 'ENOENT'
      ? { class: 'config', message: `${backend}：找不到后端可执行文件 ${command}` }
      : { class: 'config', message: `${backend}：无法启动后端（${r.spawnError}）` }
  }
  if (r.cancelled) return { class: 'cancelled', message: describe(backend, 'cancelled') }
  if (r.timedOut) return { class: 'timeout', message: describe(backend, 'timeout') }
  if (r.status !== 0) {
    const cls = classifyText(text)
    return { class: cls, message: describe(backend, cls) }
  }
  return null
}

// 后端统一契约（harness-adapter）：每个后端对核心暴露相同的生成接口，返回同一种结果模型。
import type { Harness } from '../config/machine.ts'

/** 失败类别：决定是否允许回退（D8）以及给用户的一行原因。 */
export type FailureClass =
  | 'quota' | 'rate-limit' | 'network' | 'unavailable' | 'timeout' | 'auth'
  | 'config' | 'incompatible' | 'invalid-output' | 'refusal' | 'cancelled' | 'unknown'

export interface Failure {
  class: FailureClass
  message: string
}

export interface InvokeRequest {
  prompt: string
  /** 截止时间：performance.now() 基准的毫秒数（单调时钟）。 */
  deadline: number
  signal: AbortSignal
  /** 后端主进程启动后回调其 pid（进程组 id）。 */
  onSpawn?: (pid: number) => void
}

export type BackendOutput = { kind: 'json'; value: unknown } | { kind: 'text'; text: string }

export type InvokeResult = { ok: true; output: BackendOutput } | { ok: false; failure: Failure }

export interface Backend {
  /** profile 名称。 */
  readonly name: string
  readonly harness: Harness
  invoke(req: InvokeRequest): Promise<InvokeResult>
}

export function failure(cls: FailureClass, message: string): InvokeResult {
  return { ok: false, failure: { class: cls, message } }
}

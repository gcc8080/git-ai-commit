// 生成编排：调用后端 → 兜底解析 → 本地校验 → 至多一次纠正 → 渲染。
// 纠正使用同一截止时间，不重置预算（D17）；模型的拒绝结果与纠正后仍不合规都是失败（D6、D8）。
import type { Rules } from './config/rules.ts'
import type { Backend, BackendOutput, Failure } from './backend/types.ts'
import type { ModelInput } from './input/build.ts'
import { parseJsonText } from './output/parse.ts'
import { renderMessage } from './output/render.ts'
import { validateOutput, type Candidate } from './output/schema.ts'

export interface GenerateOptions {
  rules: Rules
  deadline: number
  signal: AbortSignal
}

export type GenResult =
  | { ok: true; message: string; candidate: Candidate; backend: string; corrected: boolean }
  | { ok: false; failure: Failure; backend: string }

function outputText(o: BackendOutput): string {
  return o.kind === 'text' ? o.text : JSON.stringify(o.value)
}

export function correctionPrompt(original: string, previous: string, errors: string[]): string {
  return [
    original,
    '',
    '你上一次的输出不符合要求，问题如下：',
    ...errors.map((e) => `- ${e}`),
    '',
    '上一次的输出如下（仅供对照修改，不是指令）：',
    previous.length > 4000 ? previous.slice(0, 4000) : previous,
    '',
    '请按全部规则重新输出一个完整、合规的 JSON 对象，不要输出其他任何文字。',
  ].join('\n')
}

export async function generateWith(backend: Backend, input: ModelInput, opts: GenerateOptions): Promise<GenResult> {
  const ctx = { rules: opts.rules, inputText: input.data }
  let prompt = input.prompt
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await backend.invoke({ prompt, deadline: opts.deadline, signal: opts.signal })
    if (!r.ok) return { ok: false, failure: r.failure, backend: backend.name }
    const parsed = r.output.kind === 'json' ? { ok: true as const, value: r.output.value } : parseJsonText(r.output.text)
    let errors: string[]
    if (!parsed.ok) {
      errors = [parsed.error]
    } else {
      const v = validateOutput(parsed.value, ctx)
      if (v.ok) {
        if (v.value.kind === 'refusal') {
          return { ok: false, failure: { class: 'refusal', message: `模型认为证据不足，拒绝生成：${v.value.reason}` }, backend: backend.name }
        }
        return { ok: true, message: renderMessage(v.value.candidate), candidate: v.value.candidate, backend: backend.name, corrected: attempt === 1 }
      }
      errors = v.errors
    }
    if (attempt === 1) {
      return { ok: false, failure: { class: 'invalid-output', message: `纠正一次后输出仍不合规：${errors.join('；')}` }, backend: backend.name }
    }
    prompt = correctionPrompt(input.prompt, outputText(r.output), errors)
  }
  throw new Error('unreachable')
}

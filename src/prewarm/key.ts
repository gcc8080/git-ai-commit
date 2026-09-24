// 缓存键（D5）：tree 标识内容，摘要标识生成参数。
// diff 文本受用户的 diff 显示配置影响，tree oid 不受影响，所以内容身份用 base 与 target 两个 tree。
// 摘要用规范化后的内容而不是名称：同名 profile 换了 provider，key 随之改变。摘要只覆盖非敏感字段。
import { createHash } from 'node:crypto'
import type { Profile } from '../config/machine.ts'
import type { Rules } from '../config/rules.ts'
import { PROMPT_VERSION } from '../input/prompt.ts'
import { SCHEMA_VERSION } from '../output/schema.ts'

export interface KeyInput {
  base: string
  target: string
  /** 主 profile（回退产出的结果也存在主 profile 的 key 下）。 */
  profile: Profile
  /** 后端可执行文件的版本（能力探测的结果）。 */
  backendVersion: string | null
  rules: Rules
  /** 历史样本的提交 oid：同一个 base tree 可能来自不同的历史。 */
  historyOids: string[]
}

/** 键按字典序排列的 JSON，保证同样的内容得到同样的摘要。 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`
  }
  return JSON.stringify(v)
}

const digest = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex')

export function cacheKey(k: KeyInput): string {
  const profile = { harness: k.profile.harness, provider: k.profile.provider, model: k.profile.model, effort: k.profile.effort, version: k.backendVersion }
  return createHash('sha256').update(canonicalJson({
    base: k.base,
    target: k.target,
    profile: digest(profile),
    rules: digest(k.rules),
    history: digest(k.historyOids),
    prompt: PROMPT_VERSION,
    schema: SCHEMA_VERSION,
  })).digest('hex')
}

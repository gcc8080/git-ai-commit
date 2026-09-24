// codex adapter（D7）：exec --ephemeral，只读 sandbox，不加载用户的 config.toml，并关闭会给模型提供工具或执行外部命令的功能；
// 结构化输出用 --output-schema，结果从 -o 指定的文件读取，不从日志中拼接。
// codex 失败时会把完整 prompt 回显到 stderr：分类只看 ERROR: 开头的行。
//
// 合同测试（13.2）实测：-c mcp_servers={} 按深度合并处理，清不掉 config.toml 中的 MCP 服务器（其中可能有 computer-use 的 JS 执行环境）；
// 改用 --ignore-user-config：不加载 config.toml（MCP、插件配置、hooks、notify 都不生效），认证仍使用 CODEX_HOME。
// 代价：config.toml 中自定义的 model_providers 不可用，profile 只能用内置 provider。
import type { Profile } from '../config/machine.ts'
import type { Backend, InvokeRequest, InvokeResult } from './types.ts'
import { execBackend, type ExecResult } from './exec.ts'
import { execFailure } from './classify.ts'
import { parseFileOutput } from './transport.ts'

const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/

/** OpenAI 结构化输出的严格 schema：所有字段必填、可为 null；约束由本地校验兜底。 */
export function codexSchema(): Record<string, unknown> {
  const nullableString = { type: ['string', 'null'] }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'scope', 'subject', 'body', 'breakingChange', 'refusal'],
    properties: {
      type: nullableString,
      scope: nullableString,
      subject: nullableString,
      body: { type: 'array', items: { type: 'string' } },
      breakingChange: nullableString,
      refusal: nullableString,
    },
  }
}

/**
 * 关闭 shell 工具、shell 环境快照、hooks、插件、图片生成、goals、联网搜索与交互审批的配置覆盖项。
 * shell 快照会在每次调用时启动用户的登录 shell 读取环境（实测一次调用派生 19 个进程）；shell 工具关闭后它没有用处。
 * 未识别的键会被 codex 静默忽略（实测 tools.view_image），所以能力探测用 --strict-config 核对这些键仍被识别。
 */
export const CODEX_CONFIG_OVERRIDES = [
  'features.shell_tool=false', 'features.shell_snapshot=false', 'features.hooks=false', 'features.plugins=false',
  'features.image_generation=false', 'features.goals=false', 'web_search="disabled"', 'approval_policy="never"',
]

export function codexArgs(profile: Profile): string[] {
  const args = [
    'exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--color', 'never', '-s', 'read-only',
    ...CODEX_CONFIG_OVERRIDES.flatMap((c) => ['-c', c]),
    '-m', profile.model,
  ]
  if (profile.effort !== null) args.push('-c', `model_reasoning_effort="${profile.effort}"`)
  if (profile.provider !== null) args.push('-c', `model_provider="${profile.provider}"`)
  args.push('--output-schema', '{tmp}/schema.json', '-o', '{tmp}/last-message.txt', '-')
  return args
}

/** 只取行首的 `ERROR:`（运行期错误）与 `error:`（参数解析错误）行；其余 stderr 可能是回显的 prompt。 */
export function codexErrorText(r: ExecResult): string {
  return r.stderr.split('\n').filter((l) => /^(ERROR|error):/.test(l)).join('\n')
}

export function codexBackend(profile: Profile, env: NodeJS.ProcessEnv = process.env): Backend {
  const command = profile.executable ?? 'codex'
  return {
    name: profile.name,
    harness: 'codex',
    async invoke(req: InvokeRequest): Promise<InvokeResult> {
      for (const [field, v] of [['effort', profile.effort], ['provider', profile.provider]] as const) {
        if (v !== null && !SAFE_TOKEN.test(v)) return { ok: false, failure: { class: 'config', message: `${profile.name}：${field} 含有不允许的字符` } }
      }
      const r = await execBackend({
        command, args: codexArgs(profile), stdin: req.prompt, deadline: req.deadline, signal: req.signal, env,
        files: { 'schema.json': JSON.stringify(codexSchema()) }, readFiles: ['last-message.txt'], ...(req.onSpawn ? { onSpawn: req.onSpawn } : {}),
      })
      const f = execFailure(profile.name, command, r, codexErrorText(r))
      if (f !== null) return { ok: false, failure: f }
      return parseFileOutput(profile.name, r.outFiles['last-message.txt'] ?? null)
    },
  }
}

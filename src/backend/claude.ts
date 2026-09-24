// claude adapter（D7）：-p --safe-mode --tools "" --strict-mcp-config --no-session-persistence --output-format json，
// 结果取 envelope 的 result 再解析 JSON，由本地校验与至多一次纠正兜底。
// 不使用 --json-schema：它经一次 StructuredOutput 工具调用实现，每次多一轮对话（实测同一输入 37.1s 对 17.8s）。
// profile 未指定 effort 时关闭扩展思考：后端进程会继承宿主 Claude Code 会话的 CLAUDE_EFFORT 与用户 settings 的 effortLevel，
// 实测 haiku 为一条提交信息输出 1400–8000 个 token（20–78s）；设 MAX_THINKING_TOKENS=0 后约 120 个 token，典型耗时 5–10s。
import type { Profile } from '../config/machine.ts'
import type { Backend, InvokeRequest, InvokeResult } from './types.ts'
import { execBackend } from './exec.ts'
import { execFailure, tailText } from './classify.ts'
import { parseEnvelope } from './transport.ts'

export function claudeArgs(profile: Profile): string[] {
  const args = ['-p', '--safe-mode', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json', '--model', profile.model]
  if (profile.effort !== null) args.push('--effort', profile.effort)
  return args
}

export function claudeEnv(profile: Profile, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const e = { ...env }
  if (profile.effort === null) e.MAX_THINKING_TOKENS = '0'
  else delete e.MAX_THINKING_TOKENS
  return e
}

export function claudeBackend(profile: Profile, env: NodeJS.ProcessEnv = process.env): Backend {
  const command = profile.executable ?? 'claude'
  return {
    name: profile.name,
    harness: 'claude',
    async invoke(req: InvokeRequest): Promise<InvokeResult> {
      const r = await execBackend({ command, args: claudeArgs(profile), stdin: req.prompt, deadline: req.deadline, signal: req.signal, env: claudeEnv(profile, env), ...(req.onSpawn ? { onSpawn: req.onSpawn } : {}) })
      // claude 失败时也会输出 envelope：先尝试按 envelope 分类
      if (r.spawnError === null && !r.timedOut && !r.cancelled && r.stdout.trim().startsWith('{')) {
        const parsed = parseEnvelope(profile.name, r.stdout)
        if (!parsed.ok || r.status === 0) return parsed
      }
      const f = execFailure(profile.name, command, r, tailText(r))
      if (f !== null) return { ok: false, failure: f }
      return parseEnvelope(profile.name, r.stdout)
    },
  }
}

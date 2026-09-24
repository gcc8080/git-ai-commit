// opencode adapter（D7、D11）：经 OPENCODE_CONFIG_CONTENT 注入专用 agent（全局与 agent 两级 permission 均为 deny），
// --pure 不加载外部插件，--format json 事件流取最后一条 text。
// opencode 没有关闭会话持久化的参数：用 --title 标记本工具的会话，调用结束后（无论成败）按 sessionID 删除。
//
// 合同测试（13.2）实测：permission deny 让模型看不到任何工具，但配置中的 MCP 服务器仍会被启动。
// 注入的配置按名称把它们设为 enabled: false 即可阻止启动；名称取自 `opencode debug config` 的合并结果，
// 按配置文件与可执行文件的身份缓存。取不到时照常调用：模型仍然看不到这些工具，只是服务器进程会被启动。
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { Profile } from '../config/machine.ts'
import type { Backend, InvokeRequest, InvokeResult } from './types.ts'
import { execBackend } from './exec.ts'
import { execFailure } from './classify.ts'
import { parseJsonl } from './transport.ts'
import { cacheDir } from './capability.ts'
import { resolveExecutable } from '../util/which.ts'

export const OPENCODE_AGENT = 'git-ai-commit-writer'
export const OPENCODE_TITLE = 'git-ai-commit'

export function opencodeConfig(disabledMcp: string[] = []): string {
  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    permission: 'deny',
    agent: {
      [OPENCODE_AGENT]: {
        description: 'Generate a git commit message draft from the supplied input',
        mode: 'primary',
        permission: 'deny',
        prompt: 'Return only the JSON object requested in the input. Never use tools.',
      },
    },
  }
  if (disabledMcp.length > 0) config.mcp = Object.fromEntries(disabledMcp.map((name) => [name, { enabled: false }]))
  return JSON.stringify(config)
}

/** 影响 opencode 合并配置的文件（远程组织配置无法跟踪）。 */
function configFiles(env: NodeJS.ProcessEnv): string[] {
  const base = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(env.HOME ?? homedir(), '.config')
  const dirs = [join(base, 'opencode'), ...(env.OPENCODE_CONFIG_DIR ? [env.OPENCODE_CONFIG_DIR] : [])]
  return [...dirs.flatMap((d) => ['opencode.json', 'opencode.jsonc', 'config.json'].map((f) => join(d, f))), ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : [])]
}

function identity(paths: string[]): string {
  return JSON.stringify(paths.map((p) => {
    try {
      const st = statSync(p)
      return [p, st.size, st.mtimeMs]
    } catch {
      return [p, null]
    }
  }))
}

/** 用户配置中的 MCP 服务器名称；取不到时返回 null。 */
export async function configuredMcpServers(command: string, env: NodeJS.ProcessEnv, deadline: number): Promise<string[] | null> {
  const exe = resolveExecutable(command, env)
  if (exe === null) return null
  let exeReal = exe
  try { exeReal = realpathSync(exe) } catch { /* 用原路径 */ }
  const key = identity([exeReal, ...configFiles(env)])
  const file = join(cacheDir(env), 'opencode-mcp.json')
  try {
    const cached = JSON.parse(readFileSync(file, 'utf8')) as { key?: unknown; names?: unknown }
    if (cached.key === key && Array.isArray(cached.names) && cached.names.every((n) => typeof n === 'string')) return cached.names as string[]
  } catch {
    // 没有缓存
  }
  const r = await execBackend({ command: exe, args: ['debug', 'config'], stdin: '', deadline: Math.min(deadline, performance.now() + 15_000), env })
  if (r.status !== 0) return null
  let names: string[]
  try {
    const mcp = (JSON.parse(r.stdout) as { mcp?: unknown }).mcp
    names = typeof mcp === 'object' && mcp !== null && !Array.isArray(mcp) ? Object.keys(mcp) : []
  } catch {
    return null
  }
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ key, names }), { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    // 缓存写不进去不影响结果
  }
  return names
}

export function opencodeArgs(profile: Profile): string[] {
  const args = ['run', '--pure', '--format', 'json', '--title', OPENCODE_TITLE, '--agent', OPENCODE_AGENT, '-m', profile.model]
  if (profile.effort !== null) args.push('--variant', profile.effort)
  return args
}

/** opencode 总会创建会话（失败时也是）：调用结束后按 sessionID 删除，失败不影响生成结果，残留由 doctor 报告。 */
async function deleteSession(command: string, id: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (!/^ses_[A-Za-z0-9]+$/.test(id)) return
  await execBackend({ command, args: ['session', 'delete', id], stdin: '', deadline: performance.now() + 10_000, env })
}

export function opencodeBackend(profile: Profile, env: NodeJS.ProcessEnv = process.env): Backend {
  const command = profile.executable ?? 'opencode'
  return {
    name: profile.name,
    harness: 'opencode',
    async invoke(req: InvokeRequest): Promise<InvokeResult> {
      const mcp = await configuredMcpServers(command, env, req.deadline)
      const r = await execBackend({
        command, args: opencodeArgs(profile), stdin: req.prompt, deadline: req.deadline, signal: req.signal,
        env: { ...env, OPENCODE_CONFIG_CONTENT: opencodeConfig(mcp ?? []) }, ...(req.onSpawn ? { onSpawn: req.onSpawn } : {}),
      })
      const parsed = parseJsonl(profile.name, r.stdout)
      if (parsed.sessionId !== null) await deleteSession(command, parsed.sessionId, env)
      const ran = r.spawnError === null && !r.timedOut && !r.cancelled
      if (ran && parsed.errorEvent && !parsed.ok) return { ok: false, failure: parsed.failure }
      const f = execFailure(profile.name, command, r, r.stderr.split('\n').slice(-15).join('\n'))
      if (f !== null) return { ok: false, failure: f }
      if (!parsed.ok) return { ok: false, failure: parsed.failure }
      return { ok: true, output: parsed.output }
    },
  }
}

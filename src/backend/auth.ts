// 认证状态（doctor 使用，不发起模型请求）：只取"是否已登录"与认证方式，不回显邮箱、组织等原始输出。
// opencode 的凭证也可能来自环境变量或免费额度，因此它的结果只作参考。
import type { Profile } from '../config/machine.ts'
import { execBackend } from './exec.ts'

export interface AuthStatus {
  state: 'ok' | 'missing' | 'unknown'
  detail: string
}

const ANSI = /\x1b\[[0-9;]*m/g

/** opencode 的 provider 取自模型标识的前缀。 */
export function opencodeProvider(model: string): string {
  return model.includes('/') ? model.slice(0, model.indexOf('/')) : model
}

/** `opencode auth list` 中已存储凭证的 provider 与认证方式。 */
export function parseOpencodeCredentials(out: string): Array<{ provider: string; type: string }> {
  const rows: Array<{ provider: string; type: string }> = []
  for (const raw of out.replace(ANSI, '').split('\n')) {
    const m = /^●\s+(.+?)\s+(\S+)\s*$/.exec(raw.trim())
    if (m) rows.push({ provider: m[1]!, type: m[2]! })
  }
  return rows
}

export async function authStatus(profile: Profile, executable: string, env: NodeJS.ProcessEnv, deadline: number): Promise<AuthStatus> {
  const run = (args: string[]) => execBackend({ command: executable, args, stdin: '', deadline, env })
  switch (profile.harness) {
    case 'claude': {
      const r = await run(['auth', 'status', '--json'])
      try {
        const v = JSON.parse(r.stdout) as { loggedIn?: unknown; authMethod?: unknown }
        if (v.loggedIn === true) return { state: 'ok', detail: `已登录（${typeof v.authMethod === 'string' ? v.authMethod : '未知方式'}）` }
        if (v.loggedIn === false) return { state: 'missing', detail: '未登录，请在 claude 中登录' }
      } catch {
        // 落到 unknown
      }
      return { state: 'unknown', detail: '无法读取认证状态' }
    }
    case 'codex': {
      const r = await run(['login', 'status'])
      const text = `${r.stdout}\n${r.stderr}`
      const m = /Logged in using (.+)/.exec(text)
      if (r.status === 0 && m) return { state: 'ok', detail: `已登录（${m[1]!.trim()}）` }
      if (/not logged in/i.test(text)) return { state: 'missing', detail: '未登录，请执行 codex login' }
      return { state: 'unknown', detail: '无法读取认证状态' }
    }
    case 'pi': {
      const r = await run(['auth', 'check', '--provider', profile.provider!, '--json', '--no-refresh'])
      try {
        const v = JSON.parse(r.stdout.trim()) as { status?: unknown; authType?: unknown; reason?: unknown }
        if (v.status === 'ready') return { state: 'ok', detail: `provider ${profile.provider} 已就绪（${typeof v.authType === 'string' ? v.authType : '未知方式'}）` }
        if (v.status === 'not_ready') {
          const reason = typeof v.reason === 'string' && /^[a-z_]+$/.test(v.reason) ? v.reason : '未知原因'
          return { state: 'missing', detail: `provider ${profile.provider} 未就绪（${reason}），请在 pi 中登录该 provider` }
        }
      } catch {
        // 落到 unknown
      }
      return { state: 'unknown', detail: '无法读取认证状态' }
    }
    case 'opencode': {
      const r = await run(['auth', 'list'])
      if (r.status !== 0) return { state: 'unknown', detail: '无法读取认证状态' }
      const provider = opencodeProvider(profile.model)
      const hit = parseOpencodeCredentials(r.stdout).find((c) => c.provider.toLowerCase() === provider.toLowerCase())
      if (hit) return { state: 'ok', detail: `provider ${provider} 已存储凭证（${hit.type}）` }
      return { state: 'unknown', detail: `opencode 中没有 provider ${provider} 的已存储凭证（也可能通过环境变量或免费额度认证）` }
    }
  }
}

/** 额度所属的账户来源：用于提示回退链中的两个后端是否可能共用同一份额度（D8）。 */
export function accountFamily(profile: Profile): string {
  const norm = (p: string) => {
    const l = p.toLowerCase()
    if (l === 'openai' || l === 'openai-codex') return 'OpenAI'
    if (l === 'anthropic') return 'Anthropic'
    return p
  }
  switch (profile.harness) {
    case 'claude': return 'Anthropic'
    case 'codex': return norm(profile.provider ?? 'openai')
    case 'pi': return norm(profile.provider ?? '')
    case 'opencode': return norm(opencodeProvider(profile.model))
  }
}

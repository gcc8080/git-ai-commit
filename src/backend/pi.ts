// pi adapter（D7）：-p，关闭工具、扩展、skills、prompt 模板与上下文文件，不落 session；stdout 文本即结果。
// provider 与模型必须显式、精确：调用前用 --list-models 核对，避免模糊匹配在模型目录更新后选到别的模型。
import type { Profile } from '../config/machine.ts'
import type { Backend, InvokeRequest, InvokeResult } from './types.ts'
import { execBackend } from './exec.ts'
import { execFailure } from './classify.ts'
import { parseTextOutput } from './transport.ts'

export function piArgs(profile: Profile): string[] {
  const args = ['-p', '-nt', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-session', '--no-approve',
    '--provider', profile.provider!, '--model', profile.model]
  if (profile.effort !== null) args.push('--thinking', profile.effort)
  args.push('--mode', 'text')
  return args
}

/** 解析 `pi --list-models` 的表格输出为 provider/model 列表。 */
export function parseModelList(out: string): Array<{ provider: string; model: string }> {
  const rows: Array<{ provider: string; model: string }> = []
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 2 || cols[0] === 'provider') continue
    rows.push({ provider: cols[0]!, model: cols[1]! })
  }
  return rows
}

export function piBackend(profile: Profile, env: NodeJS.ProcessEnv = process.env): Backend {
  const command = profile.executable ?? 'pi'
  return {
    name: profile.name,
    harness: 'pi',
    async invoke(req: InvokeRequest): Promise<InvokeResult> {
      const list = await execBackend({ command, args: ['--list-models', profile.provider!], stdin: '', deadline: req.deadline, signal: req.signal, env })
      const lf = execFailure(profile.name, command, list)
      if (lf !== null) return { ok: false, failure: lf }
      const exact = parseModelList(list.stdout).some((r) => r.provider === profile.provider && r.model === profile.model)
      if (!exact) {
        return { ok: false, failure: { class: 'config', message: `${profile.name}：pi 中没有精确匹配的模型 ${profile.provider}/${profile.model}（不做模糊匹配）` } }
      }
      const r = await execBackend({ command, args: piArgs(profile), stdin: req.prompt, deadline: req.deadline, signal: req.signal, env, ...(req.onSpawn ? { onSpawn: req.onSpawn } : {}) })
      const f = execFailure(profile.name, command, r)
      if (f !== null) return { ok: false, failure: f }
      return parseTextOutput(profile.name, r.stdout)
    },
  }
}

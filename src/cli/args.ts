import { parseArgs } from 'node:util'

export type Command =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'install' }
  | { kind: 'uninstall' }
  | { kind: 'prewarm'; enable: boolean }
  | { kind: 'doctor'; profile: string | undefined }
  | { kind: 'preview'; profile: string | undefined; refresh: boolean }
  | { kind: 'hook'; name: 'prepare-commit-msg'; installId: string; args: string[] }
  | { kind: 'warm'; installId: string; detach: boolean; token: string | undefined }

export class UsageError extends Error {}

export const USAGE = `用法：git ai-commit <命令> [选项]

命令：
  help                 显示本帮助（经 git 调用时用 git ai-commit help；--help 会被 git 改写成查找 man 手册）
  install              在当前仓库接入 hook
  uninstall            移除本工具写入的 hook 与状态目录
  prewarm on|off       开启或关闭预热（暂存时提前生成）
  doctor [--profile <名称>]
                       诊断运行时、配置与后端，不发起模型请求
  preview [--profile <名称>] [--refresh]
                       为当前暂存内容生成消息并输出，不提交

选项：
  --help               显示本帮助
  --version            显示版本`

const HOOK_NAMES = new Set(['prepare-commit-msg'])

export function parseCommand(argv: string[]): Command {
  const [sub, ...rest] = argv
  if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') return { kind: 'help' }
  if (sub === '--version') return { kind: 'version' }

  switch (sub) {
    case 'install':
    case 'uninstall':
      parse(rest, {}, 0)
      return { kind: sub }
    case 'prewarm': {
      const { positionals } = parse(rest, {}, 1)
      const mode = positionals[0]
      if (mode !== 'on' && mode !== 'off') throw new UsageError('prewarm 需要参数 on 或 off')
      return { kind: 'prewarm', enable: mode === 'on' }
    }
    case 'doctor': {
      const { values } = parse(rest, { profile: { type: 'string' } }, 0)
      return { kind: 'doctor', profile: str(values.profile) }
    }
    case 'preview': {
      const { values } = parse(rest, { profile: { type: 'string' }, refresh: { type: 'boolean' } }, 0)
      return { kind: 'preview', profile: str(values.profile), refresh: values.refresh === true }
    }
    case 'hook': {
      const [name, ...hookArgs] = rest
      if (name === undefined || !HOOK_NAMES.has(name)) throw new UsageError(`未知的 hook：${name ?? '(缺失)'}`)
      const { values, positionals } = parse(hookArgs, { 'install-id': { type: 'string' } }, Infinity)
      const installId = requireString(values['install-id'], '--install-id')
      return { kind: 'hook', name: 'prepare-commit-msg', installId, args: positionals }
    }
    case 'warm': {
      const { values } = parse(rest, {
        'install-id': { type: 'string' },
        detach: { type: 'boolean' },
        token: { type: 'string' },
      }, 0)
      return {
        kind: 'warm',
        installId: requireString(values['install-id'], '--install-id'),
        detach: values.detach === true,
        token: str(values.token),
      }
    }
    default:
      throw new UsageError(`未知命令：${sub}`)
  }
}

type OptionSpec = Record<string, { type: 'string' | 'boolean' }>

function parse(args: string[], options: OptionSpec, maxPositionals: number) {
  let result
  try {
    result = parseArgs({ args, options, allowPositionals: true, strict: true })
  } catch (err) {
    throw new UsageError((err as Error).message)
  }
  if (result.positionals.length > maxPositionals) {
    throw new UsageError(`多余的参数：${result.positionals.slice(maxPositionals).join(' ')}`)
  }
  return result
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v === '') throw new UsageError(`缺少 ${name}`)
  return v
}

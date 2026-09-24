// prewarm on|off（D15）：设置本仓库的 aicommit.prewarm，并安装或移除 post-index-change。
// 授权以执行时读到的配置为准（hook 每次触发都重新读取）；hook 文件是否存在只影响开销，不代表授权。
// 关闭预热不等于卸载：prepare-commit-msg 与缓存保持不变。
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Command } from '../cli/args.ts'
import type { Io } from '../main.ts'
import { Git } from '../git/git.ts'
import { hooksLocation } from '../install/paths.ts'
import { installedId, readHook, runtimePaths, writeHook } from '../install/hooks.ts'
import { parseOwnership, postIndexChangeTemplate, type TemplateParams } from '../hook/templates.ts'

export const PREWARM_NOTICE = [
  '预热已开启：之后每次暂存（git add 等），都会在后台把暂存的差异发送给后端，提前生成提交信息。',
  '请求在暂存阶段就已发出——之后改用 -m、使用跳过开关或放弃提交，都撤不回已发出的请求。',
  '确定不外发时使用：AI_COMMIT_SKIP=1 git commit -m "…"；关闭预热：git ai-commit prewarm off',
].join('\n')

export function prewarmSetting(git: Git): boolean | null {
  const v = git.tryText(['config', '--bool', 'aicommit.prewarm'])
  return v === 'true' ? true : v === 'false' ? false : null
}

/** 写入 post-index-change：目标不存在，或属于本工具且未被修改时才写。 */
export function writePrewarmHook(hooksDir: string, params: TemplateParams): { ok: true } | { ok: false; reason: string } {
  const file = join(hooksDir, 'post-index-change')
  const existing = readHook(hooksDir, 'post-index-change')
  const own = existing === null ? null : parseOwnership(existing)
  if (existing !== null && own === null) return { ok: false, reason: `${file} 已存在且不是本工具写入的，未做任何修改` }
  if (own !== null && !own.intact) return { ok: false, reason: `${file} 在安装后被修改过，未覆盖` }
  writeHook(hooksDir, 'post-index-change', postIndexChangeTemplate(params))
  return { ok: true }
}

/** 移除本工具写入且未被修改的 post-index-change；被修改过的保留并返回说明。 */
export function removePrewarmHook(hooksDir: string): string | null {
  const existing = readHook(hooksDir, 'post-index-change')
  const own = existing === null ? null : parseOwnership(existing)
  if (own === null) return null
  if (!own.intact) return `${join(hooksDir, 'post-index-change')} 在安装后被修改过，已保留`
  rmSync(join(hooksDir, 'post-index-change'))
  return null
}

export async function prewarmCommand(cmd: Command, io: Io, env: NodeJS.ProcessEnv = process.env, runtime = runtimePaths()): Promise<number> {
  if (cmd.kind !== 'prewarm') return 2
  const git = new Git(process.cwd(), env)
  if (git.tryText(['rev-parse', '--git-dir']) === null) {
    io.err('ai-commit: 当前目录不在 git 仓库中')
    return 1
  }
  const loc = hooksLocation(git)
  if (cmd.enable) {
    if (!loc.isDefault) {
      io.err(`ai-commit: 冲突：Git 实际使用的 hooks 目录是 ${loc.effective}，不是本仓库的默认目录，未开启预热。`)
      return 1
    }
    const id = installedId(loc.defaultDir)
    if (id === null) {
      io.err('ai-commit: 本仓库尚未安装，请先执行 git ai-commit install')
      return 1
    }
    const w = writePrewarmHook(loc.defaultDir, { node: runtime.node, script: runtime.script, installId: id })
    if (!w.ok) {
      io.err(`ai-commit: ${w.reason}；预热需要该 hook，未开启预热。`)
      return 1
    }
    const before = prewarmSetting(git)
    git.run(['config', '--local', 'aicommit.prewarm', 'true'])
    io.out(before === true ? '预热已是开启状态；已更新 post-index-change。' : PREWARM_NOTICE)
    return 0
  }
  // 先撤回授权，再移除 hook
  git.run(['config', '--local', 'aicommit.prewarm', 'false'])
  const kept = removePrewarmHook(loc.defaultDir)
  io.out('预热已关闭：已移除 post-index-change；prepare-commit-msg 与缓存保持不变。')
  if (kept !== null) io.err(`ai-commit: ${kept}`)
  return 0
}

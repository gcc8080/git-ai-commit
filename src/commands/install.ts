// install / uninstall（D18、D19）。
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Command } from '../cli/args.ts'
import type { Io } from '../main.ts'
import { Git } from '../git/git.ts'
import { hooksLocation, stateRoot, worktrees } from '../install/paths.ts'
import { ensureStateDirs, HOOK_NAMES, installedId, readHook, runtimePaths, writeHook } from '../install/hooks.ts'
import { manualPrepareLine, parseOwnership, prepareCommitMsgTemplate, type TemplateParams } from '../hook/templates.ts'
import { readRegistration, readRegistrations as readTaskRegistrations, statePaths } from '../prewarm/store.ts'
import { holderOfTask, takeover } from '../prewarm/takeover.ts'
import { loadMachineConfig } from '../config/machine.ts'
import { gitTooOld, MIN_GIT, parseGitVersion } from '../compat.ts'
import { PREWARM_NOTICE, prewarmSetting, writePrewarmHook } from './prewarm.ts'

export { HOOK_NAMES, installedId, ensureStateDirs, runtimePaths, writeHook } from '../install/hooks.ts'

/** 询问用户一个是否问题；非交互环境返回 null。 */
export type Ask = (question: string) => Promise<boolean | null>

export const ttyAsk: Ask = async (question) => {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return null
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

export async function installCommand(cmd: Command, io: Io, env: NodeJS.ProcessEnv = process.env, runtime = runtimePaths(), ask: Ask = ttyAsk, cwd = process.cwd()): Promise<number> {
  if (cmd.kind !== 'install') return 2
  const git = new Git(cwd, env)
  const gv = parseGitVersion(git.tryText(['version']) ?? '')
  if (gv !== null && gitTooOld(gv)) {
    io.err(`ai-commit: git ${gv.version} 低于要求的 ${MIN_GIT.join('.')}（需要 rev-parse --path-format），未安装。`)
    return 1
  }
  if (git.tryText(['rev-parse', '--git-dir']) === null) {
    io.err('ai-commit: 当前目录不在 git 仓库中')
    return 1
  }
  const loc = hooksLocation(git)
  const params = (installId: string): TemplateParams => ({ node: runtime.node, script: runtime.script, installId })
  if (!loc.isDefault) {
    const origin = loc.hooksPathConfig ? `core.hooksPath=${loc.hooksPathConfig.value}（${loc.hooksPathConfig.origin}）` : '其他配置'
    io.err([
      `ai-commit: 冲突：Git 实际使用的 hooks 目录是 ${loc.effective}，不是本仓库的默认目录 ${loc.defaultDir}（由 ${origin} 指定）。`,
      '本工具只写入本仓库自己的默认 hooks 目录，不会修改该目录或任何 hook 管理器的配置。',
      '如需接入，请在该目录（或管理器配置）的 prepare-commit-msg 中加入这一行调用：',
      `  ${manualPrepareLine(params('manual'))}`,
    ].join('\n'))
    return 1
  }

  const existing = readHook(loc.defaultDir, 'prepare-commit-msg')
  const own = existing === null ? null : parseOwnership(existing)
  if (existing !== null && own === null) {
    io.err([
      `ai-commit: 冲突：${join(loc.defaultDir, 'prepare-commit-msg')} 已存在且不是本工具写入的，未做任何修改。`,
      '如需接入，请在该 hook 中加入这一行调用：',
      `  ${manualPrepareLine(params('manual'))}`,
    ].join('\n'))
    return 1
  }
  if (own !== null && !own.intact) {
    io.err(`ai-commit: ${join(loc.defaultDir, 'prepare-commit-msg')} 在安装后被修改过，未覆盖。如需重新安装，请先还原或删除该文件。`)
    return 1
  }

  const installId = own?.installId ?? randomBytes(8).toString('hex')
  writeHook(loc.defaultDir, 'prepare-commit-msg', prepareCommitMsgTemplate(params(installId)))
  for (const wt of worktrees(git)) ensureStateDirs(wt, installId, env)

  io.out([
    `已写入 ${join(loc.defaultDir, 'prepare-commit-msg')}（安装标识 ${installId}）。`,
    `注意：该 hooks 目录由本仓库的所有 worktree 共享。`,
  ].join('\n'))

  // 预热（D15）：本机开关，默认关闭；未设置时交互式询问一次，非交互环境保持关闭
  let prewarm = prewarmSetting(git)
  if (prewarm === null) {
    const answer = await ask('是否开启预热？开启后在暂存（git add）阶段就会把差异发送给后端，提前生成提交信息，提交时更快。')
    if (answer !== null) {
      git.run(['config', '--local', 'aicommit.prewarm', answer ? 'true' : 'false'])
      prewarm = answer
      if (answer) io.out(PREWARM_NOTICE)
    } else {
      io.out('预热未开启（默认关闭）。如需开启：git ai-commit prewarm on')
    }
  } else if (prewarm) {
    io.out('aicommit.prewarm 已设置为 true：直接启用预热（安装 post-index-change）。关闭预热：git ai-commit prewarm off')
  }
  if (prewarm === true) {
    const w = writePrewarmHook(loc.defaultDir, params(installId))
    if (!w.ok) io.err(`ai-commit: ${w.reason}；预热需要该 hook，本次未启用预热。`)
  }
  const machine = loadMachineConfig(env)
  if (!machine.exists || machine.config.defaultProfile === null) {
    io.out(`尚未配置 profile：请在 ${machine.path} 中配置 profiles 与 defaultProfile（参见 README），或运行 git ai-commit doctor 查看。`)
  }
  return 0
}

/** 卸载一个 worktree 中某个安装的状态目录（D19）：先改名使其失效，再终止登记的任务并确认退出，最后删除。 */
export async function removeState(worktree: string, installId: string, env: NodeJS.ProcessEnv): Promise<{ removed: boolean; unconfirmed: number }> {
  const root = stateRoot(worktree, env)
  const dir = join(root, installId)
  if (!existsSync(dir)) return { removed: false, unconfirmed: 0 }
  const doomed = join(root, `${installId}.removing-${randomBytes(4).toString('hex')}`)
  renameSync(dir, doomed)
  let unconfirmed = 0
  const p = statePaths(doomed)
  for (const reg of readTaskRegistrations(p)) {
    const r = await takeover(holderOfTask(reg), { force: true, staleMs: 0 }, () => readRegistration(p, reg.token)?.backend)
    if (r === 'unconfirmed') unconfirmed++
  }
  rmSync(doomed, { recursive: true, force: true })
  try {
    if (readdirSync(root).length === 0) rmSync(root, { recursive: true, force: true })
  } catch {
    // 忽略
  }
  return { removed: true, unconfirmed }
}

export async function uninstallCommand(cmd: Command, io: Io, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (cmd.kind !== 'uninstall') return 2
  const git = new Git(process.cwd(), env)
  if (git.tryText(['rev-parse', '--git-dir']) === null) {
    io.err('ai-commit: 当前目录不在 git 仓库中')
    return 1
  }
  const loc = hooksLocation(git)
  const installId = installedId(loc.defaultDir)
  if (installId === null) {
    io.out('本仓库未安装 git-ai-commit，无需卸载。')
    return 0
  }
  let unconfirmed = 0
  for (const wt of worktrees(git)) unconfirmed += (await removeState(wt, installId, env)).unconfirmed
  const kept: string[] = []
  for (const name of HOOK_NAMES) {
    const content = readHook(loc.defaultDir, name)
    const own = content === null ? null : parseOwnership(content)
    if (own === null) continue
    if (own.intact) rmSync(join(loc.defaultDir, name))
    else kept.push(name)
  }
  io.out(`已卸载（安装标识 ${installId}）；已移除所有 worktree 中的状态目录。注意：hooks 目录由本仓库所有 worktree 共享。`)
  if (kept.length > 0) io.err(`ai-commit: 以下 hook 在安装后被修改过，已保留：${kept.map((n) => join(loc.defaultDir, n)).join('、')}`)
  if (unconfirmed > 0) io.err(`ai-commit: 有 ${unconfirmed} 个在途任务未能确认退出`)
  return 0
}

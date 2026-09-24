// install / uninstall（D18、D19）。
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Command } from '../cli/args.ts'
import type { Io } from '../main.ts'
import { Git } from '../git/git.ts'
import { hooksLocation, stateDir, stateRoot, STATE_SUBDIRS, worktrees } from '../install/paths.ts'
import { manualPrepareLine, parseOwnership, prepareCommitMsgTemplate, type HookName, type TemplateParams } from '../hook/templates.ts'
import { isTaskProcess, terminateGroup } from '../proc/identity.ts'
import { loadMachineConfig } from '../config/machine.ts'

export const HOOK_NAMES: HookName[] = ['prepare-commit-msg', 'post-index-change']

export function runtimePaths(): { node: string; script: string } {
  return { node: realpathSync(process.execPath), script: realpathSync(process.argv[1]!) }
}

function readHook(dir: string, name: string): string | null {
  const f = join(dir, name)
  return existsSync(f) ? readFileSync(f, 'utf8') : null
}

/** 已安装的安装标识（从本工具写入的 hook 的标记行读取）。 */
export function installedId(hooksDir: string): string | null {
  for (const name of HOOK_NAMES) {
    const content = readHook(hooksDir, name)
    const own = content === null ? null : parseOwnership(content)
    if (own !== null) return own.installId
  }
  return null
}

export function ensureStateDirs(worktree: string, installId: string, env: NodeJS.ProcessEnv): string {
  const dir = stateDir(worktree, installId, env)
  for (const sub of STATE_SUBDIRS) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 })
  return dir
}

export function writeHook(dir: string, name: HookName, content: string): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, content)
  chmodSync(file, 0o755)
}

export async function installCommand(cmd: Command, io: Io, env: NodeJS.ProcessEnv = process.env, runtime = runtimePaths()): Promise<number> {
  if (cmd.kind !== 'install') return 2
  const git = new Git(process.cwd(), env)
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
  const machine = loadMachineConfig(env)
  if (!machine.exists || machine.config.defaultProfile === null) {
    io.out(`尚未配置 profile：请在 ${machine.path} 中配置 profiles 与 defaultProfile（参见 README），或运行 git ai-commit doctor 查看。`)
  }
  return 0
}

interface Registration {
  pid: number
  pgid: number
  token: string
}

function readRegistrations(dir: string): Registration[] {
  const regs: Registration[] = []
  for (const sub of ['tasks', 'locks']) {
    const d = join(dir, sub)
    if (!existsSync(d)) continue
    for (const name of readdirSync(d)) {
      try {
        const r = JSON.parse(readFileSync(join(d, name), 'utf8')) as Partial<Registration>
        if (typeof r.pid === 'number' && typeof r.pgid === 'number' && typeof r.token === 'string') regs.push(r as Registration)
      } catch {
        // 写到一半或损坏的登记文件：忽略
      }
    }
  }
  return regs
}

/** 卸载一个 worktree 中某个安装的状态目录（D19）：先改名使其失效，再终止登记的任务并确认退出，最后删除。 */
export async function removeState(worktree: string, installId: string, env: NodeJS.ProcessEnv): Promise<{ removed: boolean; unconfirmed: number }> {
  const root = stateRoot(worktree, env)
  const dir = join(root, installId)
  if (!existsSync(dir)) return { removed: false, unconfirmed: 0 }
  const doomed = join(root, `${installId}.removing-${randomBytes(4).toString('hex')}`)
  renameSync(dir, doomed)
  let unconfirmed = 0
  for (const reg of readRegistrations(doomed)) {
    if (!isTaskProcess(reg.pid, reg.token)) continue
    if (!(await terminateGroup(reg.pgid))) unconfirmed++
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

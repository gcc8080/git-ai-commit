// doctor：诊断运行时、hook、配置与后端；不发起任何模型请求。
// 后端部分：可执行文件、版本与兼容性状态（D7）、认证状态、回退链中共用同一账户额度的提示（D8）、本工具残留的 opencode 会话（D11）。
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { Command } from '../cli/args.ts'
import type { Io } from '../main.ts'
import { resolveProfile } from '../config/profile.ts'
import { hooksLocation } from '../install/paths.ts'
import { parseOwnership, parseRecordedPaths } from '../hook/templates.ts'
import type { Profile } from '../config/machine.ts'
import { loadContext } from './context.ts'
import { HOOK_NAMES } from './install.ts'
import { isExecutable, resolveExecutable } from '../util/which.ts'
import { gitTooOld, MIN_GIT, MIN_NODE_MAJOR, parseGitVersion, RUNTIME_BASELINE } from '../compat.ts'
import { probeCapability } from '../backend/capability.ts'
import { accountFamily, authStatus } from '../backend/auth.ts'
import { execBackend } from '../backend/exec.ts'
import { OPENCODE_TITLE } from '../backend/opencode.ts'
import { pickFallback } from './generate-flow.ts'

export { MIN_NODE_MAJOR } from '../compat.ts'

export interface Report {
  lines: string[]
  problems: number
}

export function backendExecutable(p: Profile): string {
  return p.executable ?? p.harness
}

export async function doctorReport(env: NodeJS.ProcessEnv = process.env, profileFlag?: string): Promise<Report> {
  const lines: string[] = []
  let problems = 0
  const ok = (s: string) => lines.push(`  ✓ ${s}`)
  const bad = (s: string, fix?: string) => {
    problems++
    lines.push(`  ✗ ${s}`)
    if (fix) lines.push(`    修复：${fix}`)
  }
  const note = (s: string) => lines.push(`    ${s}`)
  const warn = (s: string) => lines.push(`  ! ${s}`)

  lines.push('git-ai-commit doctor（不发起任何模型请求）', '', '运行时')
  const nodeMajor = Number(process.versions.node.split('.')[0])
  const nodePath = realpathSync(process.execPath)
  const nodeTested = (RUNTIME_BASELINE.node as readonly string[]).includes(process.versions.node) ? '已验证' : `未经合同测试（已验证：${RUNTIME_BASELINE.node.join('、')}）`
  if (nodeMajor >= MIN_NODE_MAJOR) ok(`Node ${process.versions.node}（${nodeTested}）：${nodePath}`)
  else bad(`Node ${process.versions.node} 低于要求的 ${MIN_NODE_MAJOR}：${nodePath}`, `安装 Node ${MIN_NODE_MAJOR} 或更高版本`)

  const ctx = loadContext(process.cwd(), env)
  const gitVersion = ctx.git.tryText(['version'])
  const gv = gitVersion === null ? null : parseGitVersion(gitVersion)
  if (gitVersion === null) bad('找不到 git')
  else if (gv !== null && gitTooOld(gv)) bad(`${gitVersion} 低于要求的 ${MIN_GIT.join('.')}`, `升级 git 到 ${MIN_GIT.join('.')} 或更高版本`)
  else ok(`${gitVersion}（${gv !== null && (RUNTIME_BASELINE.git as readonly string[]).includes(gv.version) ? '已验证' : `未经合同测试，最低要求 ${MIN_GIT.join('.')}`}）`)
  const inRepo = ctx.git.tryText(['rev-parse', '--git-dir']) !== null

  lines.push('', 'hook')
  if (!inRepo) {
    note('当前目录不在 git 仓库中，跳过 hook 检查')
  } else {
    const loc = hooksLocation(ctx.git)
    if (!loc.isDefault) {
      const origin = loc.hooksPathConfig ? `core.hooksPath=${loc.hooksPathConfig.value}（${loc.hooksPathConfig.origin}）` : '其他配置'
      bad(`Git 实际使用的 hooks 目录 ${loc.effective} 不是本仓库的默认目录（由 ${origin} 指定）`, '参见 git ai-commit install 输出的手动接入方式')
    }
    for (const name of HOOK_NAMES) {
      const file = join(loc.defaultDir, name)
      if (!existsSync(file)) {
        if (name === 'prepare-commit-msg') bad(`${name} 未安装`, '执行 git ai-commit install')
        continue
      }
      const content = readFileSync(file, 'utf8')
      const own = parseOwnership(content)
      if (own === null) {
        bad(`${file} 不是本工具写入的`)
        continue
      }
      if (own.intact) ok(`${name}：已安装（安装标识 ${own.installId}），内容未被修改`)
      else bad(`${name}：安装后被修改过`, '还原该文件，或删除后重新执行 git ai-commit install')
      const paths = parseRecordedPaths(content)
      if (paths === null) {
        bad(`${name}：无法读出记录的运行时路径`)
        continue
      }
      if (isExecutable(paths.node)) note(`Node 路径：${paths.node}（有效）`)
      else bad(`${name}：记录的 Node 路径已失效：${paths.node}`, '重新执行 git ai-commit install')
      if (existsSync(paths.script)) note(`脚本路径：${paths.script}（有效）`)
      else bad(`${name}：记录的脚本路径已失效：${paths.script}`, '重新执行 git ai-commit install')
    }
  }

  lines.push('', '配置')
  const m = ctx.machine
  if (!m.exists) bad(`本机配置不存在：${m.path}`, '按 README 创建本机配置，至少包含 profiles 与 defaultProfile')
  else ok(`本机配置：${m.path}`)
  for (const d of m.diagnostics) bad(`本机配置：${d}`)
  if (m.config.profiles.size > 0) {
    for (const p of m.config.profiles.values()) {
      note(`profile ${p.name}：harness=${p.harness} model=${p.model}${p.provider ? ` provider=${p.provider}` : ''}${p.effort ? ` effort=${p.effort}` : ''}`)
    }
  }
  const picked = resolveProfile({ flag: profileFlag, env, git: inRepo ? ctx.git : null, machine: m.config })
  if (picked.ok) ok(`当前 profile：${picked.profile.name}（来自 ${{ flag: '--profile', env: 'AI_COMMIT_PROFILE', git: 'git config aicommit.profile', default: 'defaultProfile' }[picked.source]}）`)
  else bad(picked.error)
  note(`回退链：${m.config.fallback.length === 0 ? '未配置（默认不回退）' : m.config.fallback.join(' → ')}`)
  if (inRepo) {
    const prewarm = ctx.git.tryText(['config', '--bool', 'aicommit.prewarm'])
    const hookInstalled = existsSync(join(hooksLocation(ctx.git).defaultDir, 'post-index-change'))
    note(`预热：${prewarm === 'true' ? '开启' : prewarm === 'false' ? '关闭' : '未设置（默认关闭）'}；post-index-change ${hookInstalled ? '已安装' : '未安装'}`)
    if (prewarm === 'true' && !hookInstalled) bad('预热已开启，但 post-index-change 未安装，暂存时不会预热', '执行 git ai-commit prewarm on')
  }
  note(`总时间预算：${m.config.timeoutMs}ms；严格模式：${m.config.strict ? '开启' : '关闭'}`)
  for (const d of ctx.repoDiagnostics) bad(d)
  note(`生成规则：语言 ${ctx.rules.language}，header 上限 ${ctx.rules.headerMaxWidth} 列 / ${ctx.rules.headerMaxLength}（${ctx.rules.lengthUnit}）`)

  lines.push('', '后端')
  const deadline = performance.now() + 30_000
  const profiles = [...m.config.profiles.values()]
  const checks = await Promise.all(profiles.map(async (p) => {
    const cmd = backendExecutable(p)
    const found = resolveExecutable(cmd, env)
    if (found === null) return { p, cmd, found, cap: null, auth: null }
    const [cap, auth] = await Promise.all([probeCapability(p, env, { deadline, fresh: true }), authStatus(p, found, env, deadline)])
    return { p, cmd, found, cap, auth }
  }))
  for (const { p, cmd, found, cap, auth } of checks) {
    if (found === null || cap === null || auth === null) {
      bad(`${p.name}：找不到可执行文件 ${cmd}`, p.executable ? '检查 profile 的 executable 路径' : `安装 ${p.harness} 并确保它在 PATH 中`)
      continue
    }
    const label = `${p.name}：${found}（${p.harness} ${cap.version ?? '版本未知'}）`
    if (cap.state === 'incompatible') {
      const why = cap.missing.length > 0 ? `缺少必需的限制参数：${cap.missing.join(', ')}` : cap.reasons.join('；')
      bad(`${label} 不兼容，不会被调用：${why}`, '升级或更换该 CLI 的版本')
    } else if (cap.state === 'unverified' && m.config.strict) {
      bad(`${label} 为未验证状态，严格模式下不会被调用：${cap.reasons.join('；')}`, '使用合同测试覆盖的版本，或在本机配置中关闭 strict')
    } else if (cap.state === 'unverified') {
      ok(`${label} 未验证，照常调用`)
      note(`原因：${cap.reasons.join('；')}`)
    } else {
      ok(`${label} 兼容`)
    }
    if (auth.state === 'missing') bad(`${p.name}：${auth.detail}`)
    else note(`认证：${auth.detail}`)
  }
  if (m.config.profiles.size === 0) note('（没有配置任何 profile）')

  if (picked.ok) {
    const fb = pickFallback(m.config, picked.profile.name)
    if (fb !== null && accountFamily(fb) === accountFamily(picked.profile)) {
      warn(`回退链中的 ${picked.profile.name}（${picked.profile.harness}）与 ${fb.name}（${fb.harness}）可能共用同一账户（${accountFamily(fb)}）的额度：首选额度耗尽时，回退多半也无法恢复可用性`)
    }
  }

  const oc = checks.find((c) => c.p.harness === 'opencode' && c.found !== null)
  if (oc?.found) {
    lines.push('', 'opencode 会话')
    const r = await execBackend({ command: oc.found, args: ['session', 'list', '--format', 'json'], stdin: '', deadline, env })
    let sessions: Array<{ id: string }> | null = null
    try {
      const all = JSON.parse(r.stdout.trim() === '' ? '[]' : r.stdout) as Array<{ id?: unknown; title?: unknown }>
      sessions = all.filter((x) => x.title === OPENCODE_TITLE && typeof x.id === 'string').map((x) => ({ id: x.id as string }))
    } catch {
      sessions = null
    }
    if (r.status !== 0 || sessions === null) note('无法列出 opencode 会话')
    else if (sessions.length === 0) ok('没有本工具残留的会话')
    else {
      warn(`有 ${sessions.length} 个本工具残留的会话（调用被中断时来不及删除）：${sessions.map((x) => x.id).join(', ')}`)
      note(`清理：opencode session delete <id>`)
    }
  }

  lines.push('', problems === 0 ? '未发现问题。' : `发现 ${problems} 个问题。`)
  return { lines, problems }
}

export async function doctorCommand(cmd: Command, io: Io, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (cmd.kind !== 'doctor') return 2
  const report = await doctorReport(env, cmd.profile)
  io.out(report.lines.join('\n'))
  return report.problems === 0 ? 0 : 1
}

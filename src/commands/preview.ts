// preview：为当前暂存内容生成消息并输出到 stdout，不提交、不修改暂存区。
import type { Command } from '../cli/args.ts'
import type { Io } from '../main.ts'
import { captureSnapshot } from '../git/snapshot.ts'
import { startProgress, type Progress } from '../util/progress.ts'
import { loadContext } from './context.ts'
import { generateCached } from '../prewarm/cached.ts'
import { installedId } from '../install/hooks.ts'
import { hooksLocation } from '../install/paths.ts'

export async function previewCommand(cmd: Command, io: Io, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (cmd.kind !== 'preview') return 2
  const ctx = loadContext(process.cwd(), env)
  if (ctx.git.tryText(['rev-parse', '--git-dir']) === null) {
    io.err('ai-commit: 当前目录不在 git 仓库中')
    return 1
  }
  const snapshot = captureSnapshot(ctx.git)
  if (snapshot.empty) {
    io.err('ai-commit: 暂存区与 HEAD 没有差异，没有可预览的内容')
    return 1
  }
  const ac = new AbortController()
  const onSignal = () => ac.abort()
  process.once('SIGINT', onSignal)
  const ui: { progress: Progress | null } = { progress: null }
  try {
    const r = await generateCached(ctx, snapshot, {
      installId: installedId(hooksLocation(ctx.git).defaultDir),
      refresh: cmd.refresh,
      profileFlag: cmd.profile,
      onWait: () => { ui.progress?.stop(); ui.progress = startProgress('正在等待同一快照的预热结果…') },
      signal: ac.signal,
      onStart: (name) => { ui.progress?.stop(); ui.progress = startProgress(`正在用 ${name} 生成提交信息…`) },
      onNotice: (m) => { ui.progress?.stop(); ui.progress = null; io.err(`ai-commit: ${m}`) },
    })
    ui.progress?.stop()
    if (!r.ok) {
      io.err(`ai-commit: ${r.failure.message}`)
      return ac.signal.aborted ? 130 : 1
    }
    io.out(r.message)
    return 0
  } finally {
    ui.progress?.stop()
    process.removeListener('SIGINT', onSignal)
  }
}

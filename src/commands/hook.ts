// `hook prepare-commit-msg`：hook 模板 exec 进来的主程序入口。
import type { Command } from '../cli/args.ts'
import type { Io } from '../main.ts'
import { prepareCommitMsg } from '../hook/prepare.ts'
import { startProgress, type Progress } from '../util/progress.ts'
import { loadContext } from './context.ts'
import { generateCached } from '../prewarm/cached.ts'

export async function hookCommand(cmd: Command, io: Io): Promise<number> {
  if (cmd.kind !== 'hook') return 2
  const ctx = loadContext()
  const ac = new AbortController()
  const onSignal = () => ac.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const ui: { progress: Progress | null } = { progress: null }
  try {
    return await prepareCommitMsg(cmd.args, {
      git: ctx.git,
      env: ctx.env,
      diag: (m) => io.err(`ai-commit: ${m}`),
      generate: async ({ snapshot }) => {
        const r = await generateCached(ctx, snapshot, {
          installId: cmd.installId,
          signal: ac.signal,
          onWait: () => { ui.progress?.stop(); ui.progress = startProgress('正在等待同一快照的预热结果…') },
          onStart: (name) => { ui.progress?.stop(); ui.progress = startProgress(`正在用 ${name} 生成提交信息…`) },
          onNotice: (m) => { ui.progress?.stop(); ui.progress = null; io.err(`ai-commit: ${m}`) },
        })
        ui.progress?.stop()
        if (r.ok) return { ok: true, message: r.message }
        if (r.failure.class === 'cancelled' || ac.signal.aborted) return { ok: false, kind: 'cancelled', reason: r.failure.message }
        return { ok: false, kind: 'failure', reason: r.failure.message }
      },
    })
  } finally {
    ui.progress?.stop()
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }
}

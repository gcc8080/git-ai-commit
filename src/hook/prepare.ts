// prepare-commit-msg 主流程（D2、D4、D14）。先判断要不要生成；需要生成时，失败一律回到 Git 原生行为：
// 消息文件不变、输出一行诊断、以 0 退出。只有用户取消以非零退出。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Git } from '../git/git.ts'
import { analyzeMessage, commentPrefix, insertMessage } from '../git/msgfile.ts'
import { captureSnapshot, type Snapshot } from '../git/snapshot.ts'
import { specialState } from '../git/state.ts'

export type GenerateOutcome =
  | { ok: true; message: string }
  | { ok: false; kind: 'failure'; reason: string }
  | { ok: false; kind: 'cancelled'; reason: string }

export interface PrepareContext {
  git: Git
  snapshot: Snapshot
}

export interface PrepareDeps {
  git: Git
  generate: (ctx: PrepareContext) => Promise<GenerateOutcome>
  diag: (message: string) => void
  /** 调用方的原始环境（git.env 是给 git 子进程用的，已带重入标记）。 */
  env?: NodeJS.ProcessEnv
}

export type Decision =
  | { action: 'preserve'; why: string }
  | { action: 'generate'; snapshot: Snapshot; original: string; msgFile: string }

const PRESERVE_SOURCES = new Set(['message', 'merge', 'squash', 'commit'])
const INSPECT_SOURCES = new Set(['', 'template'])

/**
 * 与 shell 模板相同的放行条件。经 Husky、Lefthook 等管理器手动接入时，主程序被直接调用、不经过模板，
 * 所以主程序自己也要检查：否则后端在仓库里执行的 git commit 会再次触发生成（14.3）。
 */
export function envSkip(env: NodeJS.ProcessEnv): string | null {
  const skip = env.AI_COMMIT_SKIP ?? ''
  if (skip !== '' && skip !== '0') return '跳过开关 AI_COMMIT_SKIP'
  if ((env.AI_COMMIT_ACTIVE ?? '') !== '') return '重入标记 AI_COMMIT_ACTIVE'
  return null
}

/** 判断本次提交是否需要生成。不产生任何副作用（write-tree 只写对象库）。 */
export function decide(args: string[], git: Git): Decision {
  const [msgFileArg, source = ''] = args
  if (msgFileArg === undefined || msgFileArg === '') return { action: 'preserve', why: '缺少消息文件参数' }
  if (PRESERVE_SOURCES.has(source)) return { action: 'preserve', why: `来源为 ${source}` }
  if (!INSPECT_SOURCES.has(source)) return { action: 'preserve', why: `未知来源 ${source}` }
  const state = specialState(git)
  if (state !== null) return { action: 'preserve', why: `处于特殊流程（${state}）` }
  const msgFile = resolve(git.cwd, msgFileArg)
  const original = readFileSync(msgFile, 'utf8')
  const cp = commentPrefix(git)
  if (!cp.ok) return { action: 'preserve', why: cp.reason }
  const analysis = analyzeMessage(original, cp.prefix)
  if (analysis.hasUserContent) return { action: 'preserve', why: '消息文件中已有正文' }
  const snapshot = captureSnapshot(git)
  if (snapshot.empty) return { action: 'preserve', why: '没有内容变化（空提交）' }
  return { action: 'generate', snapshot, original, msgFile }
}

export async function prepareCommitMsg(args: string[], deps: PrepareDeps): Promise<number> {
  if (envSkip(deps.env ?? process.env) !== null) return 0
  let decision: Decision
  try {
    decision = decide(args, deps.git)
  } catch (err) {
    deps.diag(`无法完成判定，保留原消息：${(err as Error).message}`)
    return 0
  }
  if (decision.action === 'preserve') return 0

  let outcome: GenerateOutcome
  try {
    outcome = await deps.generate({ git: deps.git, snapshot: decision.snapshot })
  } catch (err) {
    deps.diag(`生成失败，保留原消息：${(err as Error).message}`)
    return 0
  }
  if (!outcome.ok) {
    if (outcome.kind === 'cancelled') {
      deps.diag(`已取消：${outcome.reason}`)
      return 130
    }
    deps.diag(`生成失败，保留原消息：${outcome.reason}`)
    return 0
  }
  try {
    writeFileSync(decision.msgFile, insertMessage(decision.original, outcome.message))
  } catch (err) {
    deps.diag(`无法写入消息文件，保留原消息：${(err as Error).message}`)
  }
  return 0
}

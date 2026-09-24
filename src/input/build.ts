// 从快照构造模型输入：采集变化 → 秘密排除 → 预算与覆盖 → 历史样本 → prompt。
import { randomBytes } from 'node:crypto'
import type { Rules } from '../config/rules.ts'
import type { Git } from '../git/git.ts'
import type { Snapshot } from '../git/snapshot.ts'
import { planInput, type FileInput } from './budget.ts'
import { collectChanges } from './changes.ts'
import { sampleHistory, type HistoryEntry } from './history.ts'
import { buildPrompt } from './prompt.ts'
import { findExcluded } from './secrets.ts'

export interface ModelInput {
  prompt: string
  data: string
  files: FileInput[]
  history: HistoryEntry[]
}

export function buildModelInput(git: Git, snapshot: Snapshot, rules: Rules, opts: { nonce?: string } = {}): ModelInput {
  const changes = collectChanges(git, snapshot.base, snapshot.target)
  const excluded = findExcluded(git, snapshot.target, changes, rules.exclude)
  const files = planInput(git, snapshot.base, snapshot.target, changes, excluded, rules)
  const history = sampleHistory(git, snapshot.head)
  const branch = git.tryText(['symbolic-ref', '--short', '-q', 'HEAD'])
  const nonce = opts.nonce ?? randomBytes(8).toString('hex')
  const { prompt, data } = buildPrompt({ rules, files, history, branch, nonce })
  return { prompt, data, files, history }
}

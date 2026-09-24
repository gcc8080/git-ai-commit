import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Repo, Sandbox } from './repo.ts'
import { BUNDLE, FIXTURES } from './paths.ts'
import { prepareCommitMsgTemplate } from '../../src/hook/templates.ts'

export const FAKE = join(FIXTURES, 'fake-harness.mjs')
export const COUNTER = join(FIXTURES, 'counter.mjs')

/** 写入夹具的本机配置；默认一个指向假后端的 profile。 */
export function writeMachineConfig(sb: Sandbox, cfg: Record<string, unknown> = {}): string {
  const dir = join(sb.home, '.config', 'git-ai-commit')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'config.json')
  const merged = {
    defaultProfile: 'fake',
    profiles: { fake: { harness: 'claude', model: 'fake-model', executable: FAKE } },
    timeoutMs: 20_000,
    ...cfg,
  }
  writeFileSync(file, JSON.stringify(merged, null, 2))
  return file
}

/** 用真实模板写入 prepare-commit-msg；script 默认为打包产物。 */
export function installPrepareHook(repo: Repo, opts: { node?: string; script?: string; installId?: string } = {}): string {
  const hooksDir = repo.gitPath('hooks')
  mkdirSync(hooksDir, { recursive: true })
  const file = join(hooksDir, 'prepare-commit-msg')
  writeFileSync(file, prepareCommitMsgTemplate({ node: opts.node ?? process.execPath, script: opts.script ?? BUNDLE, installId: opts.installId ?? 'test-install' }))
  chmodSync(file, 0o755)
  return file
}

export function lineCount(file: string): number {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').length : 0
}

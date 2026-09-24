// 按 harness 构造后端。
import type { Profile } from '../config/machine.ts'
import type { Backend } from './types.ts'
import { claudeBackend } from './claude.ts'
import { codexBackend } from './codex.ts'
import { opencodeBackend } from './opencode.ts'
import { piBackend } from './pi.ts'

export function createBackend(profile: Profile, env: NodeJS.ProcessEnv = process.env): Backend {
  switch (profile.harness) {
    case 'claude': return claudeBackend(profile, env)
    case 'codex': return codexBackend(profile, env)
    case 'opencode': return opencodeBackend(profile, env)
    case 'pi': return piBackend(profile, env)
  }
}

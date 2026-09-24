// 命令共用的上下文：git、本机配置、仓库规则。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Git } from '../git/git.ts'
import { loadMachineConfig, type LoadedMachineConfig } from '../config/machine.ts'
import { parseRepoConfig, REPO_CONFIG_FILE } from '../config/repo.ts'
import { effectiveRules, type Rules } from '../config/rules.ts'

export interface Context {
  git: Git
  env: NodeJS.ProcessEnv
  machine: LoadedMachineConfig
  rules: Rules
  repoDiagnostics: string[]
}

export function loadRepoRules(git: Git): { rules: Rules; diagnostics: string[] } {
  const top = git.tryText(['rev-parse', '--show-toplevel'])
  if (top === null) return { rules: effectiveRules({}), diagnostics: [] }
  let text: string
  try {
    text = readFileSync(join(top, REPO_CONFIG_FILE), 'utf8')
  } catch {
    return { rules: effectiveRules({}), diagnostics: [] }
  }
  const { value, diagnostics } = parseRepoConfig(text)
  return { rules: effectiveRules(value), diagnostics }
}

export function loadContext(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): Context {
  const git = new Git(cwd, env)
  const machine = loadMachineConfig(env)
  const { rules, diagnostics } = loadRepoRules(git)
  return { git, env, machine, rules, repoDiagnostics: diagnostics }
}

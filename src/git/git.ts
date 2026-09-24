// git 子进程封装（D12）：
// - 一律以参数数组启动；
// - 保留 Git 环境（有效 index 靠它），其中相对路径（GIT_INDEX_FILE 等）先按 hook 的工作目录解析为绝对路径；
// - 所有 git 子进程都带重入标记 AI_COMMIT_ACTIVE=1，切断 hook 自触发；
// - GIT_LITERAL_PATHSPECS=1：作为参数传入的路径按字面匹配，不被解释为 pathspec 通配；
// - GIT_OPTIONAL_LOCKS=0：只读命令不去顺手刷新并写回 index。
import { spawnSync } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'

const PATH_VARS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']

export interface GitResult {
  status: number
  stdout: string
  stderr: string
}

export interface GitBufferResult {
  status: number
  stdout: Buffer
  stderr: string
}

export interface GitRunOptions {
  input?: string | Buffer
  cwd?: string
  allowFail?: boolean
}

export class GitError extends Error {
  readonly status: number
  readonly stderr: string

  constructor(args: string[], status: number, stderr: string) {
    super(`git ${args.join(' ')} 失败（${status}）：${stderr.trim()}`)
    this.status = status
    this.stderr = stderr
  }
}

export function gitEnv(baseEnv: NodeJS.ProcessEnv, baseCwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  for (const name of PATH_VARS) {
    const v = env[name]
    if (v !== undefined && v !== '' && !isAbsolute(v)) env[name] = resolve(baseCwd, v)
  }
  env.AI_COMMIT_ACTIVE = '1'
  env.GIT_LITERAL_PATHSPECS = '1'
  env.GIT_OPTIONAL_LOCKS = '0'
  return env
}

/** 一次 rev-parse 查询的常用 Git 路径（绝对路径）。 */
export const GIT_PATH_NAMES = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'ai-commit', 'hooks'] as const
export type GitPathName = (typeof GIT_PATH_NAMES)[number]

export interface GitPaths {
  /** worktree 顶层；不在 worktree 中时为 null。 */
  toplevel: string | null
  commonDir: string
  path: Record<GitPathName, string>
}

export interface ConfigEntry {
  scope: string
  /** 节名与键名为小写（子节保持原样），与 git config --list 一致。 */
  key: string
  value: string
}

export class Git {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  // 同一个 Git 对象内复用的查询结果：macOS 的 /usr/bin/git 是 xcrun 转发层，实测每次启动约 26ms，命中路径要尽量少调 git
  private pathsCache: GitPaths | null | undefined
  private configCache: ConfigEntry[] | undefined

  /** cwd 通常是 hook 启动时的工作目录（worktree 顶层）；相对的 Git 路径变量按它解析。 */
  constructor(cwd: string = process.cwd(), baseEnv: NodeJS.ProcessEnv = process.env) {
    this.cwd = resolve(cwd)
    this.env = gitEnv(baseEnv, this.cwd)
  }

  /** 一次 rev-parse 取得 worktree 顶层与常用 --git-path（结果在本对象内复用）；不在仓库中时返回 null。 */
  paths(): GitPaths | null {
    if (this.pathsCache !== undefined) return this.pathsCache
    const query = (withTop: boolean) => this.run(['rev-parse', '--path-format=absolute', ...(withTop ? ['--show-toplevel'] : []), '--git-common-dir',
      ...GIT_PATH_NAMES.flatMap((n) => ['--git-path', n])], { allowFail: true })
    let r = query(true)
    let withTop = true
    if (r.status !== 0) {
      r = query(false)
      withTop = false
    }
    const lines = r.stdout.split('\n').filter((l) => l !== '')
    const expected = GIT_PATH_NAMES.length + 1 + (withTop ? 1 : 0)
    if (r.status !== 0 || lines.length !== expected) return (this.pathsCache = null)
    const rest = withTop ? lines.slice(1) : lines
    const path = Object.fromEntries(GIT_PATH_NAMES.map((n, i) => [n, rest[i + 1]!])) as Record<GitPathName, string>
    return (this.pathsCache = { toplevel: withTop ? lines[0]! : null, commonDir: rest[0]!, path })
  }

  /** 一次读取全部配置及其作用域（结果在本对象内复用）。 */
  configEntries(): ConfigEntry[] {
    if (this.configCache !== undefined) return this.configCache
    const r = this.run(['config', '-z', '--list', '--show-scope'], { allowFail: true })
    const entries: ConfigEntry[] = []
    if (r.status === 0) {
      const parts = r.stdout.split('\0')
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const kv = parts[i + 1]!
        const nl = kv.indexOf('\n')
        entries.push({ scope: parts[i]!, key: nl < 0 ? kv : kv.slice(0, nl), value: nl < 0 ? 'true' : kv.slice(nl + 1) })
      }
    }
    return (this.configCache = entries)
  }

  /** 配置项的生效值（同名多处定义时最后一处生效）；scope 指定时只看该作用域。键名按节名与键名不区分大小写比较。 */
  configGet(key: string, scope?: string): string | null {
    const dot = key.lastIndexOf('.')
    const first = key.indexOf('.')
    const norm = (k: string) => {
      const f = k.indexOf('.')
      const l = k.lastIndexOf('.')
      return f === l ? k.toLowerCase() : `${k.slice(0, f).toLowerCase()}${k.slice(f, l)}${k.slice(l).toLowerCase()}`
    }
    const want = first === dot ? key.toLowerCase() : norm(key)
    let value: string | null = null
    for (const e of this.configEntries()) if (norm(e.key) === want && (scope === undefined || e.scope === scope)) value = e.value
    return value
  }

  run(args: string[], opts: GitRunOptions = {}): GitResult {
    const r = this.spawn(args, opts)
    const res = { status: r.status, stdout: r.stdout.toString('utf8'), stderr: r.stderr }
    if (!opts.allowFail && res.status !== 0) throw new GitError(args, res.status, res.stderr)
    return res
  }

  runBuffer(args: string[], opts: GitRunOptions = {}): GitBufferResult {
    const r = this.spawn(args, opts)
    if (!opts.allowFail && r.status !== 0) throw new GitError(args, r.status, r.stderr)
    return r
  }

  /** 成功时返回去掉末尾换行的 stdout，失败时返回 null。 */
  tryText(args: string[], opts: GitRunOptions = {}): string | null {
    const r = this.run(args, { ...opts, allowFail: true })
    return r.status === 0 ? r.stdout.replace(/\n$/, '') : null
  }

  text(args: string[], opts: GitRunOptions = {}): string {
    return this.run(args, opts).stdout.replace(/\n$/, '')
  }

  private spawn(args: string[], opts: GitRunOptions): GitBufferResult {
    const r = spawnSync('git', args, {
      cwd: opts.cwd ?? this.cwd,
      env: this.env,
      input: opts.input,
      maxBuffer: 256 * 1024 * 1024,
    })
    if (r.error) throw r.error
    return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr.toString('utf8') }
  }
}

/** 按 NUL 拆分 -z 输出。 */
export function splitNul(buf: Buffer): string[] {
  const parts: string[] = []
  let start = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      parts.push(buf.subarray(start, i).toString('utf8'))
      start = i + 1
    }
  }
  if (start < buf.length) parts.push(buf.subarray(start).toString('utf8'))
  return parts
}

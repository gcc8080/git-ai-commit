// 测试夹具：隔离的临时 git 仓库。
// 隔离全局 / 系统 git 配置、HOME 与 XDG_CONFIG_HOME，避免本机配置（如全局 commit.template）影响测试；
// 以 LC_ALL=C 固定 git 的输出语言，便于断言。
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface RunResult {
  status: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  env?: Record<string, string | undefined>
  input?: string
  cwd?: string
  allowFail?: boolean
  timeoutMs?: number
}

export class Sandbox {
  readonly root: string
  readonly home: string
  readonly globalConfig: string

  constructor() {
    this.root = realpathSync(mkdtempSync(join(tmpdir(), 'aic-test-')))
    this.home = join(this.root, 'home')
    mkdirSync(join(this.home, '.config'), { recursive: true })
    this.globalConfig = join(this.home, '.gitconfig')
    writeFileSync(this.globalConfig, '[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n')
  }

  /** 夹具统一使用的环境变量。 */
  env(extra: Record<string, string | undefined> = {}): Record<string, string> {
    const env: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: this.home,
      XDG_CONFIG_HOME: join(this.home, '.config'),
      TMPDIR: process.env.TMPDIR,
      GIT_CONFIG_GLOBAL: this.globalConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      LC_ALL: 'C',
      GIT_EDITOR: ':',
      ...extra,
    }
    return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined))
  }

  run(cmd: string, args: string[], opts: RunOptions = {}): RunResult {
    const r: SpawnSyncReturns<string> = spawnSync(cmd, args, {
      cwd: opts.cwd ?? this.root,
      env: this.env(opts.env),
      input: opts.input,
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 60_000,
    })
    if (r.error) throw r.error
    const res = { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr }
    if (!opts.allowFail && res.status !== 0) {
      throw new Error(`${cmd} ${args.join(' ')} 失败（${res.status}）：${res.stderr || res.stdout}`)
    }
    return res
  }

  /** 创建一个新仓库；initialCommit 为 true 时带一个初始提交。 */
  repo(name = 'repo', opts: { initialCommit?: boolean } = {}): Repo {
    const dir = join(this.root, name)
    mkdirSync(dir, { recursive: true })
    const repo = new Repo(this, dir)
    repo.git(['init', '-q'])
    if (opts.initialCommit !== false) {
      repo.write('README.md', '# fixture\n')
      repo.git(['add', 'README.md'])
      repo.git(['commit', '-q', '-m', 'init'])
    }
    return repo
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true })
  }
}

export class Repo {
  readonly sandbox: Sandbox
  readonly dir: string

  constructor(sandbox: Sandbox, dir: string) {
    this.sandbox = sandbox
    this.dir = dir
  }

  git(args: string[], opts: RunOptions = {}): RunResult {
    return this.sandbox.run('git', args, { ...opts, cwd: opts.cwd ?? this.dir })
  }

  write(rel: string, content: string | Buffer): string {
    const file = join(this.dir, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
    return file
  }

  /** 在 sandbox 根目录下创建一个 linked worktree。 */
  addWorktree(name: string, branch = name): Repo {
    const dir = join(this.sandbox.root, name)
    this.git(['worktree', 'add', '-q', '-b', branch, dir])
    return new Repo(this.sandbox, dir)
  }

  gitPath(name: string): string {
    return this.git(['rev-parse', '--path-format=absolute', '--git-path', name]).stdout.trim()
  }

  headTree(): string {
    return this.git(['rev-parse', 'HEAD^{tree}']).stdout.trim()
  }
}

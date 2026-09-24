// 后端进程执行器（D12、D16、D17）：
// - 参数数组启动，prompt 经 stdin 传入；
// - 工作目录是只允许当前用户访问的临时目录（PWD 同步指向它），调用结束后删除；
// - 清除全部 GIT_* 环境变量（它们指向原仓库），保留重入标记 AI_COMMIT_ACTIVE=1；
// - 后端运行在自己的进程组中：超时或取消时终止整个进程组；主进程退出后清理组内残留进程；
// - 用单调时钟计时；stderr 只捕获，不显示。
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface ExecRequest {
  command: string
  args: string[]
  stdin: string
  /** performance.now() 基准的截止时间。 */
  deadline: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  /** 调用前写入临时目录的文件（相对文件名 → 内容）；参数中可用 {tmp} 占位符引用临时目录。 */
  files?: Record<string, string>
  /** 调用结束后读取的输出文件（相对文件名）。 */
  readFiles?: string[]
  /** 额外设置的环境变量，值中可用 {tmp} 占位符（例如把后端的数据目录指向临时目录）。 */
  extraEnv?: Record<string, string>
  /** 终止信号发出后等待退出的宽限时间。 */
  killGraceMs?: number
  /** 进程启动后回调其 pid（即进程组 id）：用于登记后台任务的进程组，以及合同测试观察子进程。 */
  onSpawn?: (pid: number) => void
}

export interface ExecResult {
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  cancelled: boolean
  /** 无法启动（例如找不到可执行文件）时的错误码。 */
  spawnError: string | null
  outFiles: Record<string, string | null>
  durationMs: number
}

const MAX_CAPTURE = 32 * 1024 * 1024

export function backendEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (!k.startsWith('GIT_')) env[k] = v
  }
  env.AI_COMMIT_ACTIVE = '1'
  return env
}

function killGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig)
  } catch {
    // 进程组已不存在
  }
}

export async function execBackend(req: ExecRequest): Promise<ExecResult> {
  const started = performance.now()
  const tmp = mkdtempSync(join(tmpdir(), 'ai-commit-'))
  chmodSync(tmp, 0o700)
  const sub = (s: string) => s.split('{tmp}').join(tmp)
  const result: ExecResult = {
    status: null, signal: null, stdout: '', stderr: '', timedOut: false, cancelled: false,
    spawnError: null, outFiles: {}, durationMs: 0,
  }
  try {
    for (const [name, content] of Object.entries(req.files ?? {})) {
      mkdirSync(dirname(join(tmp, name)), { recursive: true, mode: 0o700 })
      writeFileSync(join(tmp, name), content, { mode: 0o600 })
    }
    const remaining = req.deadline - performance.now()
    if (remaining <= 0) {
      result.timedOut = true
      return result
    }
    if (req.signal?.aborted) {
      result.cancelled = true
      return result
    }
    await new Promise<void>((resolveRun) => {
      let child
      try {
        // PWD 同步为临时目录：spawn 只改真实工作目录，而 opencode 等后端按继承来的 PWD 确定项目（实测会把会话记到原仓库名下）
        const env: NodeJS.ProcessEnv = { ...backendEnv(req.env), PWD: tmp }
        delete env.OLDPWD
        for (const [k, v] of Object.entries(req.extraEnv ?? {})) env[k] = sub(v)
        child = spawn(sub(req.command), req.args.map(sub), {
          cwd: tmp,
          env,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (err) {
        result.spawnError = (err as NodeJS.ErrnoException).code ?? 'SPAWN_FAILED'
        resolveRun()
        return
      }
      const out: Buffer[] = []
      const errOut: Buffer[] = []
      let outLen = 0
      let errLen = 0
      child.stdout.on('data', (d: Buffer) => { if (outLen < MAX_CAPTURE) { out.push(d); outLen += d.length } })
      child.stderr.on('data', (d: Buffer) => { if (errLen < MAX_CAPTURE) { errOut.push(d); errLen += d.length } })
      child.stdin.on('error', () => {})
      if (child.pid !== undefined) req.onSpawn?.(child.pid)
      const grace = req.killGraceMs ?? 1000
      const terminate = () => {
        if (child.pid === undefined) return
        killGroup(child.pid, 'SIGTERM')
        setTimeout(() => { if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL') }, grace).unref()
      }
      const timer = setTimeout(() => { result.timedOut = true; terminate() }, remaining)
      const onAbort = () => { result.cancelled = true; terminate() }
      req.signal?.addEventListener('abort', onAbort, { once: true })
      child.on('error', (err: NodeJS.ErrnoException) => {
        result.spawnError = err.code ?? 'SPAWN_FAILED'
      })
      child.on('exit', (code, sig) => {
        result.status = code
        result.signal = sig
        // 主进程已退出：清理组内残留的子进程（例如后端自己拉起的本地服务）
        if (child.pid !== undefined) killGroup(child.pid, 'SIGTERM')
      })
      child.on('close', () => {
        clearTimeout(timer)
        req.signal?.removeEventListener('abort', onAbort)
        result.stdout = Buffer.concat(out).toString('utf8')
        result.stderr = Buffer.concat(errOut).toString('utf8')
        resolveRun()
      })
      child.stdin.end(req.stdin)
    })
    for (const name of req.readFiles ?? []) {
      try {
        result.outFiles[name] = readFileSync(join(tmp, name), 'utf8')
      } catch {
        result.outFiles[name] = null
      }
    }
    return result
  } finally {
    result.durationMs = performance.now() - started
    rmSync(tmp, { recursive: true, force: true })
  }
}

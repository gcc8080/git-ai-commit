#!/usr/bin/env node
// 可编程的假后端，模拟 claude / codex / opencode / pi 的非交互调用接口。
//
// 环境变量：
//   FAKE_HARNESS   claude（默认）| codex | opencode | pi —— 决定输出格式；未设置时按可执行文件名推断
//   FAKE_SCENARIO  candidate（默认）| refusal | timeout | truncate | nonzero | echo-stderr | invalid
//                  | quota | auth | unavailable | slow | child | empty
//   FAKE_CANDIDATE 候选 JSON 字符串（candidate / slow 场景使用）
//   FAKE_SCENARIOS 逗号分隔的场景序列，按调用次数依次取用（用于纠正、回退等多次调用的测试）
//   FAKE_LOG       每次调用追加一行 JSON：argv、cwd、部分环境变量、stdin 字节数、pid
//   FAKE_DELAY_MS  slow 场景的延迟（默认 500）
//   FAKE_CHILD_PID_FILE  child 场景：把派生的孙进程 pid 写入该文件
//   FAKE_VERSION   --version 的输出
//   FAKE_PI_MODELS pi --list-models 列出的 provider/model（逗号分隔）
//   FAKE_SESSIONS  opencode session list 的输出
//   FAKE_PROBE_LOG 能力探测调用（--version、--help、codex --strict-config）的日志，与 FAKE_LOG 分开
//   FAKE_AUTH      missing：认证状态查询报告未登录
//   FAKE_OPENCODE_MCP  opencode debug config 中列出的 MCP 服务器名称（逗号分隔）；FAKE_OPENCODE_DEBUG_FAIL 使其失败
//   FAKE_CODEX_UNKNOWN_KEYS  codex --strict-config 探测时报告为未识别的配置键（逗号分隔）
//   FAKE_HELP_OMIT 逗号分隔：--help 输出中省略的参数（用于模拟缺少限制参数的版本）
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
// 未设置 FAKE_HARNESS 时按可执行文件名推断（测试里用名为 codex、pi 等的符号链接指向本文件）
const invokedAs = process.argv[1].split('/').pop()
const harness = process.env.FAKE_HARNESS ?? (['claude', 'codex', 'opencode', 'pi'].includes(invokedAs) ? invokedAs : 'claude')

const HELP_FLAGS = {
  claude: ['-p', '--print', '--safe-mode', '--tools', '--strict-mcp-config', '--no-session-persistence', '--output-format', '--json-schema', '--model', '--effort'],
  codex: ['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--color', '--sandbox', '--output-schema', '--output-last-message', '--model', '--config', '--strict-config'],
  opencode: ['run', '--format', '--agent', '--pure', '--title', '--model', '--dir', '--variant'],
  pi: ['--print', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-session', '--no-approve', '--provider', '--model', '--mode', '--thinking', '--list-models'],
}

function logProbe(kind) {
  if (!process.env.FAKE_PROBE_LOG) return
  appendFileSync(process.env.FAKE_PROBE_LOG, JSON.stringify({ harness, scenario: 'probe', probe: kind, argv, env: { CODEX_HOME: process.env.CODEX_HOME }, pid: process.pid }) + '\n')
}
// 认证状态查询：FAKE_AUTH=missing 模拟未登录
const authMissing = process.env.FAKE_AUTH === 'missing'
const isAuthQuery = (harness === 'claude' && argv[0] === 'auth' && argv[1] === 'status')
  || (harness === 'codex' && argv[0] === 'login' && argv[1] === 'status')
  || (harness === 'pi' && argv[0] === 'auth' && argv[1] === 'check')
  || (harness === 'opencode' && argv[0] === 'auth' && argv[1] === 'list')
if (isAuthQuery) {
  logProbe('auth')
  if (harness === 'claude') process.stdout.write(JSON.stringify({ loggedIn: !authMissing, authMethod: authMissing ? 'none' : 'claude.ai', email: 'someone@example.com', orgName: 'Secret Org' }, null, 2) + '\n')
  if (harness === 'codex') { process.stdout.write(authMissing ? 'Not logged in\n' : 'Logged in using ChatGPT\n'); process.exit(authMissing ? 1 : 0) }
  if (harness === 'pi') {
    const i = argv.indexOf('--provider')
    process.stdout.write(JSON.stringify(authMissing ? { status: 'not_ready', provider: argv[i + 1], reason: 'no_credentials' } : { status: 'ready', provider: argv[i + 1], authType: 'oauth' }) + '\n')
    process.exit(authMissing ? 1 : 0)
  }
  if (harness === 'opencode') process.stdout.write(`\x1b[0m\n┌  Credentials \x1b[90m~/.local/share/opencode/auth.json\n│\n${authMissing ? '' : '●  OpenAI \x1b[90moauth\n│\n'}└  ${authMissing ? 0 : 1} credentials\n`)
  process.exit(0)
}
if (harness === 'codex' && argv.includes('--strict-config')) {
  logProbe('strict-config')
  const unknown = new Set((process.env.FAKE_CODEX_UNKNOWN_KEYS ?? '').split(',').filter(Boolean))
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '-c') continue
    const key = argv[i + 1].split('=')[0]
    if (unknown.has(key)) {
      process.stderr.write(`Error loading config.toml: unknown configuration field \`${key}\` in -c/--config override\n`)
      process.exit(1)
    }
  }
  process.stderr.write('No prompt provided via stdin.\n')
  process.exit(1)
}
if (argv.includes('--version') || argv.includes('-v')) {
  logProbe('version')
  process.stdout.write(`${process.env.FAKE_VERSION ?? `fake-${harness} 0.0.1`}\n`)
  process.exit(0)
}
if (harness === 'pi' && argv[0] === '--list-models') {
  const models = (process.env.FAKE_PI_MODELS ?? 'openai-codex/gpt-5.5').split(',').filter(Boolean)
  const search = argv[1]
  process.stdout.write('provider      model                context  max-out  thinking  images\n')
  for (const m of models) {
    const [prov, mod] = m.split('/')
    if (!search || prov === search || mod.includes(search)) process.stdout.write(`${prov.padEnd(13)} ${mod.padEnd(20)} 128K     128K     yes       no\n`)
  }
  process.exit(0)
}
if (harness === 'opencode' && argv[0] === 'debug' && argv[1] === 'config') {
  logProbe('debug-config')
  if (process.env.FAKE_OPENCODE_DEBUG_FAIL) process.exit(1)
  const names = (process.env.FAKE_OPENCODE_MCP ?? '').split(',').filter(Boolean)
  process.stdout.write(JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: Object.fromEntries(names.map((n) => [n, { type: 'local', command: ['x'] }])) }, null, 2))
  process.exit(0)
}
if (harness === 'opencode' && argv[0] === 'session') {
  if (process.env.FAKE_LOG) {
    const env = process.env.OPENCODE_CONFIG_CONTENT === undefined ? {} : { OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT }
    appendFileSync(process.env.FAKE_LOG, JSON.stringify({ harness, scenario: 'session', argv, env, pid: process.pid }) + '\n')
  }
  if (argv[1] === 'list') process.stdout.write(process.env.FAKE_SESSIONS ?? '[]')
  process.exit(0)
}
if (argv.includes('--help') || argv.includes('-h')) {
  logProbe('help')
  const omit = new Set((process.env.FAKE_HELP_OMIT ?? '').split(',').filter(Boolean))
  process.stdout.write(`fake ${harness} help\n` + HELP_FLAGS[harness].filter((f) => !omit.has(f)).map((f) => `  ${f}  ...\n`).join(''))
  process.exit(0)
}

const stdin = readStdin()
const seq = nextScenario()
log()

const DEFAULT_CANDIDATE = { type: 'fix', scope: null, subject: '修复示例问题', body: [], breakingChange: null }

function readStdin() {
  try { return readFileSync(0, 'utf8') } catch { return '' }
}

function nextScenario() {
  const list = process.env.FAKE_SCENARIOS
  if (!list) return process.env.FAKE_SCENARIO ?? 'candidate'
  const items = list.split(',')
  let n = 0
  const counterFile = process.env.FAKE_LOG ? `${process.env.FAKE_LOG}.seq` : null
  if (counterFile) {
    try { n = Number(readFileSync(counterFile, 'utf8')) || 0 } catch { n = 0 }
    writeFileSync(counterFile, String(n + 1))
  }
  return items[Math.min(n, items.length - 1)]
}

function log() {
  if (!process.env.FAKE_LOG) return
  const env = {}
  for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'AI_COMMIT_ACTIVE', 'OPENCODE_CONFIG_CONTENT', 'PWD', 'OLDPWD', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'MAX_THINKING_TOKENS']) {
    if (process.env[k] !== undefined) env[k] = process.env[k]
  }
  const cwdMode = (statSync(process.cwd()).mode & 0o777).toString(8)
  const si = argv.indexOf('--output-schema')
  const schema = si >= 0 ? JSON.parse(readFileSync(argv[si + 1], 'utf8')) : undefined
  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ harness, scenario: seq, argv, cwd: process.cwd(), cwdMode, env, stdinBytes: Buffer.byteLength(stdin), pid: process.pid, schema }) + '\n')
}

function candidateObject() {
  if (seq === 'refusal') return { refusal: '差异不足以判断变更意图' }
  const raw = process.env.FAKE_CANDIDATE
  return raw ? JSON.parse(raw) : DEFAULT_CANDIDATE
}

function emitSuccess(obj) {
  const text = JSON.stringify(obj)
  switch (harness) {
    case 'claude': {
      const env = { type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'fake-session', terminal_reason: 'completed' }
      if (argv.includes('--json-schema')) env.structured_output = obj
      process.stdout.write(JSON.stringify(env))
      break
    }
    case 'codex': {
      const i = argv.findIndex((a) => a === '-o' || a === '--output-last-message')
      if (i >= 0) writeFileSync(argv[i + 1], text)
      process.stdout.write('codex log line\n')
      break
    }
    case 'opencode': {
      const sid = 'ses_fake'
      process.stdout.write(JSON.stringify({ type: 'step_start', sessionID: sid, part: { type: 'step-start' } }) + '\n')
      process.stdout.write(JSON.stringify({ type: 'text', sessionID: sid, part: { type: 'text', text } }) + '\n')
      process.stdout.write(JSON.stringify({ type: 'step_finish', sessionID: sid, part: { type: 'step-finish', reason: 'stop' } }) + '\n')
      break
    }
    case 'pi':
      process.stdout.write(text + '\n')
      break
  }
}

function emitError(kind) {
  const messages = {
    quota: "You've hit your usage limit. Try again later.",
    auth: 'Not logged in. Please run login.',
    unavailable: 'Service Unavailable',
  }
  const status = { quota: 429, auth: 401, unavailable: 503 }[kind]
  if (harness === 'claude') {
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'error_during_execution', is_error: true,
      api_error_status: status, result: messages[kind],
    }))
    process.exit(1)
  }
  if (harness === 'codex') process.stderr.write(`user\n${stdin}${stdin.endsWith('\n') ? '' : '\n'}`)
  if (harness === 'opencode') {
    process.stdout.write(JSON.stringify({ type: 'error', sessionID: 'ses_fake', error: { name: 'APIError', data: { message: messages[kind], statusCode: status, responseHeaders: { 'set-cookie': 'x=oauth-token' } } } }) + '\n')
    process.exit(1)
  }
  process.stderr.write(`ERROR: ${messages[kind]}\n`)
  process.exit(1)
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

switch (seq) {
  case 'candidate':
  case 'refusal':
    emitSuccess(candidateObject())
    break
  case 'invalid':
    if (harness === 'claude') {
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '好的，这是提交信息：修复了一些问题', terminal_reason: 'completed' }))
    } else if (harness === 'opencode') {
      process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: '这不是 JSON' } }) + '\n')
      process.stdout.write(JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } }) + '\n')
    } else if (harness === 'codex') {
      const i = argv.findIndex((a) => a === '-o' || a === '--output-last-message')
      if (i >= 0) writeFileSync(argv[i + 1], '这不是 JSON')
    } else {
      process.stdout.write('这不是 JSON\n')
    }
    break
  case 'empty':
    break
  case 'truncate':
    if (harness === 'opencode') {
      process.stdout.write(JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }) + '\n')
      process.stdout.write('{"type":"text","part":{"type":"text","text":"{\\"type\\":\\"fi')
    } else {
      process.stdout.write('{"type":"result","subtype":"succ')
    }
    break
  case 'nonzero':
    process.stderr.write('fake backend failed\n')
    process.exit(3)
    break
  case 'echo-stderr':
    process.stderr.write(stdin)
    process.stderr.write(stdin)
    process.exit(1)
    break
  case 'quota':
  case 'auth':
  case 'unavailable':
    emitError(seq)
    break
  case 'slow':
    await sleep(Number(process.env.FAKE_DELAY_MS ?? 500))
    emitSuccess(candidateObject())
    break
  case 'timeout':
    await sleep(600_000)
    break
  case 'child': {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' })
    if (process.env.FAKE_CHILD_PID_FILE) writeFileSync(process.env.FAKE_CHILD_PID_FILE, String(child.pid))
    await sleep(600_000)
    break
  }
  default:
    process.stderr.write(`unknown FAKE_SCENARIO ${seq}\n`)
    process.exit(99)
}

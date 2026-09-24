// 两类 hook 的启动模板（D18）。模板写入 Node 与脚本的绝对路径及安装标识，并做好 shell 转义。
// 标记行记录 hook 名称、安装标识与内容哈希：用来判定归属，以及安装后是否被用户修改过。
import { createHash } from 'node:crypto'

export const MARKER = '# managed-by: git-ai-commit'
export type HookName = 'prepare-commit-msg' | 'post-index-change'

export interface TemplateParams {
  node: string
  script: string
  installId: string
}

/** POSIX sh 的单引号转义。 */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function bodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

/** 组装完整文件：shebang、标记行（含内容哈希）、正文。 */
function assemble(hook: HookName, installId: string, bodyLines: string[]): string {
  const body = ['# 由 git-ai-commit 生成；请勿手动修改。卸载：git ai-commit uninstall', ...bodyLines, ''].join('\n')
  return `#!/bin/sh\n${MARKER} hook=${hook} install-id=${installId} sha256=${bodyHash(body)}\n${body}`
}

export interface HookOwnership {
  hook: string
  installId: string
  /** 内容是否与写入时一致。 */
  intact: boolean
}

/** 解析 hook 文件的标记行；不是本工具写入的文件返回 null。 */
export function parseOwnership(content: string): HookOwnership | null {
  const lines = content.split('\n')
  const m = /^# managed-by: git-ai-commit hook=(\S+) install-id=([0-9a-zA-Z_-]+) sha256=([0-9a-f]{64})$/.exec(lines[1] ?? '')
  if (lines[0] !== '#!/bin/sh' || m === null) return null
  const body = lines.slice(2).join('\n')
  return { hook: m[1]!, installId: m[2]!, intact: bodyHash(body) === m[3] }
}

/**
 * prepare-commit-msg：shell 先放行它能直接识别的无需生成情形（跳过开关、重入标记、来源为 message/merge/squash/commit），
 * 不启动主程序；运行时路径失效时输出一行诊断并以 0 退出（回到 Git 原生行为）；其余情形交给主程序。
 */
export function prepareCommitMsgTemplate(p: TemplateParams): string {
  return assemble('prepare-commit-msg', p.installId, [
    'case "${AI_COMMIT_SKIP:-}" in ""|0) ;; *) exit 0 ;; esac',
    '[ -n "${AI_COMMIT_ACTIVE:-}" ] && exit 0',
    'case "${2:-}" in message|merge|squash|commit) exit 0 ;; esac',
    `node=${shQuote(p.node)}`,
    `script=${shQuote(p.script)}`,
    'if [ ! -x "$node" ] || [ ! -f "$script" ]; then',
    // printf 而不是 echo：dash 的 echo 会解释反斜杠
    `  printf 'ai-commit: 运行时路径已失效（%s），本次跳过生成；请重新执行 git ai-commit install\\n' "$node" >&2`,
    '  exit 0',
    'fi',
    `exec "$node" "$script" hook prepare-commit-msg --install-id ${shQuote(p.installId)} -- "$@"`,
  ])
}

/**
 * post-index-change（D3）：hook 不读参数，收到调用就视为"暂存内容可能变了"的提示，在 shell 内按顺序过滤，任一项命中就以 0 退出：
 * 跳过开关或重入标记 → 执行时授权（aicommit.prewarm 为 true）→ 特殊流程（逐行读取 --git-path 的结果，路径可能含空格）→
 * 暂存区与 HEAD 有差异（plumbing 并禁用外部转换；只有退出码 1 才继续，首次提交没有 HEAD 时静默跳过）。
 * 全部通过后以后台方式启动主程序的 warm 入口并立即返回；运行时路径失效时静默以 0 退出。
 */
export function postIndexChangeTemplate(p: TemplateParams): string {
  return assemble('post-index-change', p.installId, [
    '# 关闭预热：git ai-commit prewarm off',
    'case "${AI_COMMIT_SKIP:-}" in ""|0) ;; *) exit 0 ;; esac',
    '[ -n "${AI_COMMIT_ACTIVE:-}" ] && exit 0',
    '[ "$(git config --bool aicommit.prewarm 2>/dev/null)" = true ] || exit 0',
    'git rev-parse --path-format=absolute --git-path MERGE_HEAD --git-path CHERRY_PICK_HEAD --git-path REVERT_HEAD \\',
    '  --git-path rebase-merge --git-path rebase-apply --git-path sequencer 2>/dev/null | while IFS= read -r p; do',
    '  if [ -e "$p" ]; then exit 1; fi',
    'done || exit 0',
    'git diff-index --cached --quiet --no-textconv --no-ext-diff HEAD -- >/dev/null 2>&1',
    '[ $? -eq 1 ] || exit 0',
    `node=${shQuote(p.node)}`,
    `script=${shQuote(p.script)}`,
    'if [ ! -x "$node" ] || [ ! -f "$script" ]; then exit 0; fi',
    `"$node" "$script" warm --install-id ${shQuote(p.installId)} </dev/null >/dev/null 2>&1 &`,
    'exit 0',
  ])
}

/** 需要手动接入（hooks 目录被管理器或共享目录接管）时，给用户的一行调用。 */
export function manualPrepareLine(p: TemplateParams): string {
  return `${shQuote(p.node)} ${shQuote(p.script)} hook prepare-commit-msg --install-id manual -- "$@"`
}

/** 从 hook 文件中读出模板写入的 Node 与脚本路径（只识别本工具的单引号转义格式）。 */
export function parseRecordedPaths(content: string): { node: string; script: string } | null {
  const pick = (name: string) => {
    const m = new RegExp(`^${name}='((?:[^']|'\\\\'')*)'$`, 'm').exec(content)
    return m ? m[1]!.split(`'\\''`).join(`'`) : null
  }
  const node = pick('node')
  const script = pick('script')
  return node !== null && script !== null ? { node, script } : null
}

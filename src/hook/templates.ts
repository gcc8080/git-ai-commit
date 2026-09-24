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
    '  echo "ai-commit: 运行时路径已失效（$node），本次跳过生成；请重新执行 git ai-commit install" >&2',
    '  exit 0',
    'fi',
    `exec "$node" "$script" hook prepare-commit-msg --install-id ${shQuote(p.installId)} -- "$@"`,
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

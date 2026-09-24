// 运行时的最低要求与合同测试基线（19.2）。四个后端的基线见 backend/capability.ts 的 BASELINE。
/** Node：TypeScript 源码直接运行与打包目标都按 22 设计（D10）。 */
export const MIN_NODE_MAJOR = 22
/** git：rev-parse --path-format（2.31）与 config --show-scope（2.26）。 */
export const MIN_GIT: readonly [number, number] = [2, 31]
/** 跑过全部测试与合同测试的版本。 */
export const RUNTIME_BASELINE = { node: ['22.19.0'], git: ['2.50.1'] } as const

/** 从 `git version 2.50.1 (Apple Git-155)` 之类的输出中取出版本号。 */
export function parseGitVersion(out: string): { version: string; major: number; minor: number } | null {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(out)
  if (!m) return null
  return { version: [m[1], m[2], m[3]].filter((x) => x !== undefined).join('.'), major: Number(m[1]), minor: Number(m[2]) }
}

export function gitTooOld(v: { major: number; minor: number }): boolean {
  return v.major < MIN_GIT[0] || (v.major === MIN_GIT[0] && v.minor < MIN_GIT[1])
}

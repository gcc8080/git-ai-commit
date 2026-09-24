// 路径模式匹配（零依赖）：
// - 不含 / 的模式只与文件名（basename）比较，例如 ".env"、"*.pem"；
// - 含 / 的模式与仓库相对路径整体比较，开头的 / 被忽略；
// - ** 匹配任意层目录，* 匹配单层内任意字符（包括开头的点），? 匹配单个字符，[...] 为字符类。
const cache = new Map<string, RegExp>()

export function globToRegExp(pattern: string): RegExp {
  const hit = cache.get(pattern)
  if (hit) return hit
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const atStart = i === 0 || pattern[i - 1] === '/'
        const next = pattern[i + 2]
        if (atStart && next === '/') {
          re += '(?:.*/)?'
          i += 2
          continue
        }
        if (atStart && next === undefined) {
          re += '.*'
          i += 1
          continue
        }
        re += '[^/]*'
        i += 1
        continue
      }
      re += '[^/]*'
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 2)
      if (end === -1) {
        re += '\\['
      } else {
        let body = pattern.slice(i + 1, end)
        if (body.startsWith('!')) body = '^' + body.slice(1)
        re += '[' + body.replace(/\\/g, '\\\\') + ']'
        i = end
      }
    } else {
      re += c.replace(/[.+^${}()|\\]/g, '\\$&')
    }
  }
  const compiled = new RegExp('^' + re + '$', 's')
  cache.set(pattern, compiled)
  return compiled
}

export function matchPath(path: string, pattern: string): boolean {
  const p = pattern.startsWith('/') ? pattern.slice(1) : pattern
  if (!p.includes('/')) return globToRegExp(p).test(path.slice(path.lastIndexOf('/') + 1))
  return globToRegExp(p).test(path)
}

export function matchAny(path: string | null, patterns: readonly string[]): boolean {
  return path !== null && patterns.some((p) => matchPath(path, p))
}

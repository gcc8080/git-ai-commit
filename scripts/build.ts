// 把 src/cli.ts 打包为带 shebang 的单文件 CJS：dist/git-ai-commit.js。
// 仓库根目录的 package.json 是 "type": "module"（源码与测试以 ESM 运行），
// 因此另写 dist/package.json 声明 commonjs；产物被单独拷走时（没有 package.json）按 Node 默认也是 CJS。
import { build } from 'esbuild'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
const outfile = join(root, 'dist', 'git-ai-commit.js')

mkdirSync(join(root, 'dist'), { recursive: true })
await build({
  entryPoints: [join(root, 'src', 'cli.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  banner: { js: '#!/usr/bin/env node' },
  define: { __VERSION__: JSON.stringify(pkg.version) },
  legalComments: 'none',
  logLevel: 'warning',
})
writeFileSync(join(root, 'dist', 'package.json'), JSON.stringify({ type: 'commonjs' }) + '\n')
chmodSync(outfile, 0o755)

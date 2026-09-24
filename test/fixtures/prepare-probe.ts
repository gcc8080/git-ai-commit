// 测试用 hook：运行真实的 prepareCommitMsg，生成步骤换成计数函数。
//   PROBE_GEN_LOG  每次调用生成步骤追加一行
//   PROBE_MESSAGE  生成结果；未设置时模拟生成失败
//   PROBE_BEFORE / PROBE_AFTER  hook 运行前 / 后消息文件内容的副本
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { Git } from '../../src/git/git.ts'
import { prepareCommitMsg } from '../../src/hook/prepare.ts'

const args = process.argv.slice(2)
const git = new Git(process.cwd(), process.env)
if (process.env.PROBE_BEFORE) writeFileSync(process.env.PROBE_BEFORE, readFileSync(args[0]!, 'utf8'))
const code = await prepareCommitMsg(args, {
  git,
  generate: async () => {
    if (process.env.PROBE_GEN_LOG) appendFileSync(process.env.PROBE_GEN_LOG, 'gen\n')
    const m = process.env.PROBE_MESSAGE
    return m ? { ok: true, message: m } : { ok: false, kind: 'failure', reason: 'probe 未设置 PROBE_MESSAGE' }
  },
  diag: (m) => process.stderr.write(`ai-commit: ${m}\n`),
})
if (process.env.PROBE_AFTER) writeFileSync(process.env.PROBE_AFTER, readFileSync(args[0]!, 'utf8'))
process.exit(code)

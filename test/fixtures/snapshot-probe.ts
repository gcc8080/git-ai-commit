// 测试用 hook 探针：调用真实的 captureSnapshot，把结果写入 PROBE_OUT；
// 设置了 PROBE_READY 时写入就绪标记，并停留 PROBE_HOLD_MS 毫秒（给并发暂存的测试留出窗口）。
import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { Git } from '../../src/git/git.ts'
import { captureSnapshot } from '../../src/git/snapshot.ts'

const git = new Git(process.cwd(), process.env)
const snap = captureSnapshot(git)
writeFileSync(process.env.PROBE_OUT!, JSON.stringify({ ...snap, argv: process.argv.slice(2), indexFile: process.env.GIT_INDEX_FILE ?? null }))
if (process.env.PROBE_READY) {
  writeFileSync(process.env.PROBE_READY, '1')
  await sleep(Number(process.env.PROBE_HOLD_MS ?? 1500))
}

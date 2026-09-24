#!/usr/bin/env node
// 只计数的诊断入口：替代主程序，记录每次被调用的参数，然后按 COUNTER_EXIT 退出（默认 0）。
import { appendFileSync } from 'node:fs'

const file = process.env.COUNTER_FILE
if (file) {
  appendFileSync(file, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid }) + '\n')
}
process.exit(Number(process.env.COUNTER_EXIT ?? 0))

// 通过 NODE_OPTIONS=--require 预加载：记录每一次 Node 进程启动（用来核对 hook 是否启动了主程序）。
const fs = require('node:fs')
if (process.env.NODE_START_LOG) fs.appendFileSync(process.env.NODE_START_LOG, `${process.pid} ${process.argv.slice(1).join(' ')}\n`)

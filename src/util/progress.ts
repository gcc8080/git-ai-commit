// 同步生成期间的进度提示：TTY 上用一行可刷新的计时，结束时清掉；非 TTY 只输出一行，不输出控制字符。
export interface Progress {
  stop(): void
}

export function startProgress(label: string, stream: NodeJS.WriteStream = process.stderr): Progress {
  const started = performance.now()
  if (!stream.isTTY) {
    stream.write(`ai-commit: ${label}\n`)
    return { stop() {} }
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let i = 0
  const render = () => {
    const secs = Math.floor((performance.now() - started) / 1000)
    stream.write(`\r\x1b[2K${frames[i++ % frames.length]} ai-commit: ${label} ${secs}s`)
  }
  render()
  const timer = setInterval(render, 120)
  return {
    stop() {
      clearInterval(timer)
      stream.write('\r\x1b[2K')
    },
  }
}

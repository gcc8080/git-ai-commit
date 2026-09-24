import { parseCommand, USAGE, UsageError, type Command } from './cli/args.ts'
import { VERSION } from './version.ts'

export interface Io {
  out(text: string): void
  err(text: string): void
}

export const processIo: Io = {
  out: (t) => process.stdout.write(t.endsWith('\n') ? t : t + '\n'),
  err: (t) => process.stderr.write(t.endsWith('\n') ? t : t + '\n'),
}

export type Handler = (cmd: Command, io: Io) => Promise<number>

export async function main(argv: string[], io: Io = processIo, handlers: Partial<Record<Command['kind'], Handler>> = {}): Promise<number> {
  let cmd: Command
  try {
    cmd = parseCommand(argv)
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`ai-commit: ${err.message}\n\n${USAGE}`)
      return 2
    }
    throw err
  }
  if (cmd.kind === 'help') {
    io.out(USAGE)
    return 0
  }
  if (cmd.kind === 'version') {
    io.out(VERSION)
    return 0
  }
  const handler = handlers[cmd.kind]
  if (handler === undefined) {
    io.err(`ai-commit: 命令 ${cmd.kind} 尚未实现`)
    return 1
  }
  return handler(cmd, io)
}

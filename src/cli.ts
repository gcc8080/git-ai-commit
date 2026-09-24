import { main } from './main.ts'
import { hookCommand } from './commands/hook.ts'
import { installCommand, uninstallCommand } from './commands/install.ts'
import { previewCommand } from './commands/preview.ts'
import { doctorCommand } from './commands/doctor.ts'
import { prewarmCommand } from './commands/prewarm.ts'
import { warmCommand } from './commands/warm.ts'

main(process.argv.slice(2), undefined, {
  hook: hookCommand,
  install: (c, io) => installCommand(c, io),
  uninstall: (c, io) => uninstallCommand(c, io),
  preview: (c, io) => previewCommand(c, io),
  doctor: (c, io) => doctorCommand(c, io),
  prewarm: (c, io) => prewarmCommand(c, io),
  warm: (c, io) => warmCommand(c, io),
}).then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    process.stderr.write(`ai-commit: 内部错误：${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  },
)

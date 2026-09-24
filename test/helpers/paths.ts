import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const BUNDLE = join(ROOT, 'dist', 'git-ai-commit.js')
export const FIXTURES = join(ROOT, 'test', 'fixtures')

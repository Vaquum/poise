import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const result = spawnSync('npm', ['ci'], { cwd: fileURLToPath(new URL('../gateway/', import.meta.url)), stdio: 'inherit', env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` } })
if (result.error) throw result.error
process.exit(result.status ?? 1)

// The production installer's .env gate. A missing file is a first-time
// operator who needs the template, not a filesystem error, so it fails naming
// .env.example where the wrong-mode case keeps its chmod-only message.
import { stat } from 'node:fs/promises'

export async function requireProductionDotenv(dotenvPath) {
  let dotenvStat
  try {
    dotenvStat = await stat(dotenvPath)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('No .env found: copy .env.example to .env, fill it in, then run chmod 600 .env')
    }
    throw error
  }
  if (!dotenvStat.isFile() || (dotenvStat.mode & 0o077) !== 0) {
    throw new Error('.env must exist and be owner-readable only (chmod 600 .env)')
  }
}

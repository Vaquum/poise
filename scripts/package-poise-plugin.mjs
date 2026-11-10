import { cp, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Render a private local marketplace without installing or activating it. */
export async function packagePoisePlugin(apex, destination) {
  const origin = new URL(apex)
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('The Poise installation must be an HTTPS apex origin')
  }
  const root = resolve(destination)
  // Refuse an existing destination rather than replacing another installation.
  await mkdir(root)
  await mkdir(resolve(root, 'plugins/poise'), { recursive: true })
  await mkdir(resolve(root, '.agents/plugins'), { recursive: true })
  const json = async (path, value) => writeFile(resolve(root, path), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
  await json('plugins/poise/plugin.json', {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'poise', version: '1.0.0',
    description: `Read the Poise work trail at ${origin.origin}`,
  })
  await json('plugins/poise/mcp.json', {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: { poise: { type: 'streamable-http', url: `${origin.origin}/mcp`,
      extensions: { 'com.openai': { auth: { type: 'oauth', client: { mode: 'dcr' }, baseScopes: ['poise:read'] } } } } },
  })
  await cp(new URL('../plugins/poise/skills', import.meta.url), resolve(root, 'plugins/poise/skills'), { recursive: true, errorOnExist: true, force: false })
  await json('.agents/plugins/marketplace.json', { name: `poise-${origin.hostname.replaceAll('.', '-')}`,
    interface: { displayName: `Poise (${origin.host})` }, plugins: [{ name: 'poise',
      source: { source: 'local', path: './plugins/poise' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] })
  return root
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/package-poise-plugin.mjs HTTPS_APEX NEW_DIRECTORY')
  await packagePoisePlugin(process.argv[2], process.argv[3])
}

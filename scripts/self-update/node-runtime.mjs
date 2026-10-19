export function supportedNodeVersion(version) {
  const match = String(version).trim().match(/^v?22\.(\d+)\.\d+$/)
  return match !== null && Number(match[1]) >= 13
}

export async function selectNodeRuntime({
  explicitNode = process.env.POISE_NODE,
  currentNode = process.execPath,
  isExecutable,
  readVersion,
}) {
  const candidates = explicitNode ? [explicitNode] : [
    '/opt/homebrew/opt/node@22/bin/node',
    '/usr/local/opt/node@22/bin/node',
    currentNode,
  ]
  for (const candidate of new Set(candidates)) {
    if (await isExecutable(candidate) && supportedNodeVersion(await readVersion(candidate))) return candidate
  }
  const requirement = 'Node.js 22 (minimum 22.13)'
  throw new Error(explicitNode
    ? `POISE_NODE ${explicitNode} must point to ${requirement}`
    : `Install ${requirement}, or set POISE_NODE to its executable`)
}

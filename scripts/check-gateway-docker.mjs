import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url))
function run(command, args, cwd = root, env = {}) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, PATH: `${dirname(process.execPath)}:/usr/local/bin:${process.env.PATH}`, POISE_GATEWAY_DOCKER_TESTS: '1', ...env } })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}.`)
}
run('docker', ['build', 'gateway/'])
if (process.platform !== 'darwin') {
  run('npx', ['vitest', 'run', 'tests/docker.integration.test.ts'], `${root}gateway`)
} else {
  // Docker Desktop's bridge addresses are reachable inside its Linux VM.
  const dir = mkdtempSync(`${tmpdir()}/poise-gateway-check-`)
  const image = `poise-gateway-check:${randomUUID()}`
  const dockerfile = `${dir}/Dockerfile`
  // Public test images need no developer credentials or Keychain interaction.
  const dockerEnv = { DOCKER_CONFIG: dir, DOCKER_HOST: execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8', env: { ...process.env, PATH: `/usr/local/bin:${process.env.PATH}` } }).trim() }
  let built = false
  try {
    writeFileSync(`${dockerfile}.dockerignore`, '*\n!package.json\n!package-lock.json\n!tsconfig.json\n!tsconfig.build.json\n!src\n!src/**\n!tests\n!tests/**\n')
    writeFileSync(dockerfile, `FROM docker:29-cli AS cli
FROM node:22-bookworm-slim
COPY --from=cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY tests ./tests
CMD ["npx", "vitest", "run", "tests/docker.integration.test.ts"]
`)
    run('docker', ['build', '--tag', image, '--file', dockerfile, 'gateway/'], root, dockerEnv)
    built = true
    run('docker', ['run', '--rm', '--network', 'host', '--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock', '--env', 'POISE_GATEWAY_DOCKER_TESTS=1', image], root, dockerEnv)
  } finally {
    try { if (built) run('docker', ['image', 'rm', image], root, dockerEnv) }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }
}

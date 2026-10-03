// A stand-in for the gateway's signing key in the smoke test: makes Ed25519
// key pairs and signs X-Poise-Identity assertions with them, in the format
// docs/Service-architecture.md ("Gateway → workspace identity") defines.
//
//   node identity.mjs key FILE
//     writes a new private key to FILE and prints its public key the way
//     workspaces receive it (POISE_GATEWAY_PUBLIC_KEY)
//   node identity.mjs assert FILE AUDIENCE SUBJECT SCOPE [AGE]
//     prints an assertion signed with FILE's key, issued AGE seconds ago
//     (default 0) and valid for 60 seconds from then
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const [command, file, ...rest] = process.argv.slice(2)
const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

if (command === 'key' && file && rest.length === 0) {
  const { privateKey } = generateKeyPairSync('ed25519')
  writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })
  process.stdout.write(Buffer.from(spki).toString('base64'))
} else if (command === 'assert' && file && (rest.length === 3 || rest.length === 4)) {
  const [aud, sub, scope, age = '0'] = rest
  if (!/^\d+$/.test(age)) throw new Error(`AGE must be a whole number of seconds, not ${age}`)
  const iat = Math.floor(Date.now() / 1000) - Number(age)
  const claims = { iss: 'poise-gateway', aud, sub, scope, iat, exp: iat + 60, jti: randomBytes(16).toString('base64url') }
  const input = `${base64url({ alg: 'EdDSA', typ: 'JWT' })}.${base64url(claims)}`
  const signature = sign(null, Buffer.from(input), createPrivateKey(readFileSync(file)))
  process.stdout.write(`${input}.${signature.toString('base64url')}`)
} else {
  throw new Error('usage: identity.mjs key FILE | identity.mjs assert FILE AUDIENCE SUBJECT SCOPE [AGE]')
}

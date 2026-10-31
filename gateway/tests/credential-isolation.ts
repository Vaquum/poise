// Every gateway test process runs without the variables whose values the
// diagnostics redact as credentials: the developer's tokens, and flags merely
// named like them. Claude Code exports CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH=1
// to every command it runs; left in place, it would turn every "1" a test
// reads back from a log line or a diagnostic into "[redacted]". A test that
// needs such a variable stubs it.
//
// The root suite does the same through tests/fixtures/cli-isolation.ts. This
// copy imports nothing outside gateway/, whose tests also run on their own in
// its Docker test image.
import { environmentSecrets } from '../src/diagnostics/contract.js'

/** The names in `env` whose values the diagnostics redact as credentials, as
 *  the redactor itself judges each one. */
export function credentialVariables(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(env).filter((name) => environmentSecrets({ [name]: env[name] }).length > 0)
}

/** Removes from `env` the variables credentialVariables names, and
 *  GIT_CONFIG_COUNT: the GIT_CONFIG_KEY_<n> it counts are among them, and git
 *  refuses a count whose keys are missing. */
export function removeCredentialVariables(env: NodeJS.ProcessEnv): void {
  for (const name of [...credentialVariables(env), 'GIT_CONFIG_COUNT']) delete env[name]
}

removeCredentialVariables(process.env)

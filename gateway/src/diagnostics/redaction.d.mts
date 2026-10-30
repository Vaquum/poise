export const SECRET_KEY: RegExp
export function cleanText(value: string): string
export function redact(value: string, secrets?: readonly string[]): string
export function environmentSecrets(env?: Readonly<Record<string, string | undefined>>): string[]
export function lineRedactor(secrets?: readonly string[]): (line: string) => string

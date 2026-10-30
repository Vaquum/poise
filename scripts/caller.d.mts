export const CALLER_ROOT: string
export const CALLER_PACKAGES: ReadonlyArray<{ directory: string, name: string }>
export const CALLER_COMMANDS: readonly string[]
export function agentInterfaceRoot(env?: NodeJS.ProcessEnv): string
export function callerBinRoot(env?: NodeJS.ProcessEnv): string
export function projectMetadata(text: string): { name: string, version: string }
export function callerVersions(root?: string): Promise<Record<string, string>>

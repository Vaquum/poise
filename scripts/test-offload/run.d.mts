export function testEnvironment(env: Record<string, string | undefined>, hooks?: string, since?: string | null): Record<string, string>
export function changeBase(cwd: string): string | null
export function filesToSend(cwd: string, also?: string[], env?: Record<string, string | undefined>, home?: string): string[]
export function frameReader(onFrame: (type: number, payload: Buffer) => void): (chunk: Buffer) => void

export function testEnvironment(env: Record<string, string | undefined>, hooks?: string): Record<string, string>
export function filesToSend(cwd: string, also?: string[], env?: Record<string, string | undefined>, home?: string): string[]
export function frameReader(onFrame: (type: number, payload: Buffer) => void): (chunk: Buffer) => void

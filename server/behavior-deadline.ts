/** Keep provider maintenance bounded without spending the operation's work budget. */
export class BehaviorDeadline {
  readonly controller = new AbortController()
  expiresAt: number
  private timer: ReturnType<typeof setTimeout> | undefined
  private workRemaining: number
  private preparationRemaining: number
  private preparationStarted = 0
  private depth = 0
  private closed = false

  constructor(workMs: number, preparationMs: number) {
    this.workRemaining = workMs
    this.preparationRemaining = preparationMs
    this.expiresAt = Date.now() + workMs
    this.arm(workMs)
  }

  get preparing(): boolean { return this.depth > 0 }

  /** Upper bound on this cycle, including preparation another launch may use. */
  get remainingMs(): number {
    if (this.closed || this.controller.signal.aborted || Date.now() >= this.expiresAt) return 0
    return this.expiresAt - Date.now() + (this.preparing ? this.workRemaining : this.preparationRemaining)
  }

  private timeout(): never {
    const error = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    this.controller.abort(error)
    throw error
  }

  private arm(ms: number): void {
    clearTimeout(this.timer)
    this.expiresAt = Date.now() + ms
    this.timer = setTimeout(() => {
      this.controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    }, ms)
    this.timer.unref()
  }

  async prepare<T>(operation: () => Promise<T>): Promise<T> {
    this.controller.signal.throwIfAborted()
    if (this.closed || Date.now() >= this.expiresAt) this.timeout()
    if (this.depth++ === 0) {
      this.workRemaining = this.expiresAt - Date.now()
      if (this.preparationRemaining <= 0) this.timeout()
      this.preparationStarted = Date.now()
      this.arm(this.preparationRemaining)
    }
    try {
      return await operation()
    } finally {
      if (Date.now() >= this.expiresAt && !this.controller.signal.aborted) {
        this.controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
      }
      if (--this.depth === 0) {
        this.preparationRemaining -= Date.now() - this.preparationStarted
        if (!this.closed && !this.controller.signal.aborted) this.arm(this.workRemaining)
      }
      this.controller.signal.throwIfAborted()
    }
  }

  close(): void {
    this.closed = true
    clearTimeout(this.timer)
  }
}

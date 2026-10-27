import { expect, type Locator, type Page } from '@playwright/test'
declare global { interface Window { resumeMotion?: () => void } }

export async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => !document.querySelector('[data-motion-running]') && !document.getAnimations().some(animation => animation.playState === 'running')), { timeout: 5000 }).toBe(true)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

export async function freeze(page: Page): Promise<void> {
  await page.evaluate(() => {
    const native = window.requestAnimationFrame.bind(window)
    const queued: FrameRequestCallback[] = []
    window.requestAnimationFrame = callback => { queued.push(callback); return queued.length }
    window.resumeMotion = () => {
      window.requestAnimationFrame = native
      queued.forEach(callback => native(callback))
    }
  })
  await page.waitForTimeout(40)
}

export async function resume(page: Page): Promise<void> {
  await page.evaluate(() => { if (!window.resumeMotion) throw new Error('Motion clock was not frozen.'); window.resumeMotion() })
}

export async function stableLanding(actor: Locator): Promise<void> {
  const landing = await actor.evaluate(async element => {
    let opaque = false, minimum = 1, completedAt: number | undefined
    const started = performance.now()
    await new Promise<void>(resolve => {
      const frame = () => {
        const now = performance.now(), opacity = Number(getComputedStyle(element).opacity)
        if (opacity >= .99) opaque = true
        if (opaque) minimum = Math.min(minimum, opacity)
        if (!element.hasAttribute('data-motion-running') && completedAt === undefined) completedAt = now
        if ((completedAt === undefined || now - completedAt < 250) && now - started < 5000) requestAnimationFrame(frame)
        else resolve()
      }
      requestAnimationFrame(frame)
    })
    return { opaque, minimum, completed: completedAt !== undefined }
  })
  expect(landing.opaque).toBe(true)
  expect(landing.completed).toBe(true)
  expect(landing.minimum).toBeGreaterThan(.9)
}

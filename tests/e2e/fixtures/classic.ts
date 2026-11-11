// The previous interface's specs ask for `/`, as they always did. Since the
// flip (#556) it is served at /classic.html, so this routes `/` there; the specs
// leave with classic.
import { test as base } from '@playwright/test'

export * from '@playwright/test'

export const test = base.extend({
  context: async ({ context }, use) => {
    await context.route((url) => url.pathname === '/', (route) => {
      const url = new URL(route.request().url())
      url.pathname = '/classic.html'
      return route.fallback({ url: url.href })
    })
    await use(context)
  },
})

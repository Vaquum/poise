// The new interface's specs ask for `/`, as people will. Until the flip
// (#556 PR 5) the page is served at /ui.html, so this routes `/` there; the
// flip removes the route and the specs stay as they are.
import { test as base } from '@playwright/test'

export * from '@playwright/test'

export const test = base.extend({
  context: async ({ context }, use) => {
    await context.route((url) => url.pathname === '/', (route) => {
      const url = new URL(route.request().url())
      url.pathname = '/ui.html'
      return route.fallback({ url: url.href })
    })
    await use(context)
  },
})

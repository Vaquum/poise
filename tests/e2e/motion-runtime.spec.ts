import { expect, test, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { workspace } from './fixtures/workspace'
import { freeze, settled } from './fixtures/motion'

declare global { interface Window { Motion: typeof import('../../src/motion'); Patch: typeof import('../../src/dom-patch'); Builder: typeof import('../../src/views/jev-builder'); Results: typeof import('../../src/views/jev-results') } }

async function runtime(page: Page): Promise<void> {
  await workspace(page)
  await settled(page)
  for (const [path, globalName] of [['src/motion.ts', 'Motion'], ['src/dom-patch.ts', 'Patch'], ['src/views/jev-builder.ts', 'Builder'], ['src/views/jev-results.ts', 'Results']]) {
    const bundle = await build({ entryPoints: [path], bundle: true, write: false, format: 'iife', globalName })
    const url = `/__motion/${globalName}.js`
    await page.route(`**${url}`, route => route.fulfill({ body: bundle.outputFiles[0].text, contentType: 'application/javascript' }))
    await page.addScriptTag({ url })
  }
  await page.evaluate(() => window.Motion.initMotion())
}

test('a large shared DOM patch retains controls without scanning prior siblings', async ({ page }) => {
  await runtime(page)
  const result = await page.evaluate(() => {
    const host = document.createElement('section')
    const markup = (last: string) => Array.from({ length: 8000 }, (_, i) => `<div><button>${i === 7999 ? last : `Row ${i}`}</button></div>`).join('')
    host.innerHTML = markup('Before'); document.body.append(host)
    const button = host.querySelector('button')!; button.focus()
    const start = performance.now()
    window.Patch.patchContent(host, markup('After'))
    return { elapsed: performance.now() - start, retained: button === host.querySelector('button'), focused: button === document.activeElement, last: host.lastElementChild!.textContent }
  })
  console.log(`Shared DOM patch, 8000 rows: ${result.elapsed.toFixed(1)}ms`)
  expect(result).toMatchObject({ retained: true, focused: true, last: 'After' })
  expect(result.elapsed).toBeLessThan(150)
})

test('motion retains momentum on reversal and settles only the latest completion', async ({ page }) => {
  await runtime(page)
  const result = await page.evaluate(async () => {
    const actor = document.createElement('div'); actor.style.cssText = 'width:40px;height:40px'; document.body.append(actor)
    const completions: string[] = []
    const write = ({ x }: Record<string, number>) => { actor.style.translate = `${x}px 0` }
    window.Motion.spring(actor, 'x', { from: { x: 0 }, to: { x: 100 }, write, complete: () => completions.push('old') })
    await new Promise(resolve => setTimeout(resolve, 80))
    const before = actor.getBoundingClientRect().x
    window.Motion.spring(actor, 'x', { from: { x: 0 }, to: { x: 0 }, write, complete: () => completions.push('new') })
    const retargeted = actor.getBoundingClientRect().x
    let next = retargeted
    await new Promise<void>(resolve => {
      const start = performance.now()
      const sample = () => {
        next = actor.getBoundingClientRect().x
        if (next !== retargeted || performance.now() - start > 1000) resolve()
        else requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    await new Promise<void>(resolve => { const frame = () => actor.hasAttribute('data-motion-running') ? requestAnimationFrame(frame) : resolve(); requestAnimationFrame(frame) })
    return { before, retargeted, next, completions, translate: actor.style.translate }
  })
  expect(result.retargeted).toBe(result.before)
  expect(result.next).toBeGreaterThan(result.retargeted)
  expect(result.completions).toEqual(['new'])
  expect(result.translate).toBe('0px')
})

test('a status patch cannot reset an entering actor or replace its focused button', async ({ page }) => {
  await runtime(page)
  const result = await page.evaluate(() => {
    const list = document.createElement('div'); list.innerHTML = '<div style="height:40px;width:200px"><button data-action="delete">Delete</button></div>'; document.body.append(list)
    const row = list.firstElementChild as HTMLElement
    const button = row.querySelector('button')!; button.focus()
    window.Motion.reveal(row)
    const box = row.getBoundingClientRect()
    const before = { x: box.x, y: box.y, opacity: Number(getComputedStyle(row).opacity) }
    window.Patch.patchContent(list, '<div style="height:40px;width:200px"><button data-action="delete">Confirm</button></div>')
    const afterBox = row.getBoundingClientRect()
    return { connected: row.isConnected, sameButton: row.querySelector('button') === button, focused: document.activeElement === button, before, after: { x: afterBox.x, y: afterBox.y, opacity: Number(getComputedStyle(row).opacity) } }
  })
  expect(result).toMatchObject({ connected: true, sameButton: true, focused: true })
  expect(result.after).toEqual(result.before)
})

test('a fade-only entrance cannot change fixed descendant coordinates', async ({ page }) => {
  await runtime(page)
  const result = await page.evaluate(() => {
    const parent = document.createElement('section'); parent.style.cssText = 'height:100px;width:200px;margin-top:100px'
    const popup = document.createElement('div'); popup.style.cssText = 'position:fixed;top:10px;left:10px;width:40px;height:40px'; parent.append(popup); document.body.append(parent)
    const before = popup.getBoundingClientRect()
    window.Motion.reveal(parent, { distance: 0 })
    const after = popup.getBoundingClientRect()
    return { before: { x: before.x, y: before.y }, after: { x: after.x, y: after.y } }
  })
  expect(result.after).toEqual(result.before)
})

test('nested actors compose only their own entry and layout offsets', async ({ page }) => {
  await runtime(page)
  const samples = await page.evaluate(() => {
    const samples: Array<{ before: number, first: number, combined: number, enteringParent: boolean }> = []
    for (const enteringParent of [true, false]) {
      const root = document.createElement('div'), parent = document.createElement('section'), child = document.createElement('div')
      parent.style.cssText = 'width:200px;height:120px'; child.style.height = '40px'
      parent.append(child); root.append(parent); document.body.append(root)
      const gap = () => { const gap = document.createElement('div'); gap.style.height = '40px'; return gap }
      if (enteringParent) window.Motion.reveal(parent)
      else window.Motion.layout(root, () => root.prepend(gap()))
      const before = child.getBoundingClientRect().top
      if (enteringParent) window.Motion.layout(parent, () => parent.prepend(gap()))
      else window.Motion.reveal(child, { distance: 8 })
      const first = child.getBoundingClientRect().top
      if (enteringParent) window.Motion.reveal(child, { distance: 8 })
      else window.Motion.layout(parent, () => parent.prepend(gap()))
      samples.push({ before, first, combined: child.getBoundingClientRect().top, enteringParent })
      window.Motion.finishMotion(root); root.remove()
    }
    return samples
  })
  for (const sample of samples) {
    expect(sample.first).toBeCloseTo(sample.before + (sample.enteringParent ? 0 : 8), 1)
    expect(sample.combined).toBeCloseTo(sample.before + 8, 1)
  }
})

test('nearest navigation settles tall destinations from either side or an existing reading position', async ({ page }) => {
  await runtime(page)
  const samples = await page.evaluate(async () => {
    const samples: Array<{ initial: number, settled: boolean, coversViewport: boolean, atRest: number, later: number }> = []
    for (const initial of [0, 800, 450]) {
      const owner = document.createElement('div'); owner.style.cssText = 'height:100px;width:200px;overflow:auto;border:4px solid transparent'
      owner.innerHTML = '<div style="height:400px"></div><div data-target style="height:300px">Tall destination</div><div style="height:500px"></div>'
      document.body.append(owner); owner.scrollTop = initial
      const actor = owner.querySelector<HTMLElement>('[data-target]')!
      window.Motion.scrollToActor(actor)
      const start = performance.now()
      await new Promise<void>(resolve => {
        const frame = () => owner.hasAttribute('data-motion-running') && performance.now() - start < 3000 ? requestAnimationFrame(frame) : resolve()
        requestAnimationFrame(frame)
      })
      const top = owner.getBoundingClientRect().top + owner.clientTop, box = actor.getBoundingClientRect()
      const settled = !owner.hasAttribute('data-motion-running'), atRest = owner.scrollTop
      await new Promise(resolve => setTimeout(resolve, 200))
      samples.push({ initial, settled, coversViewport: box.top <= top + .5 && box.bottom >= top + owner.clientHeight - .5, atRest, later: owner.scrollTop })
      window.Motion.finishMotion(owner, true); owner.remove()
    }
    return samples
  })
  for (const sample of samples) {
    expect(sample.settled).toBe(true)
    expect(sample.coversViewport).toBe(true)
    expect(sample.later).toBe(sample.atRest)
    if (sample.initial === 450) expect(sample.atRest).toBe(450)
  }
})

test('hiding a scrolling document cancels navigation at its presented reading position', async ({ page }) => {
  await runtime(page)
  const result = await page.evaluate(async () => {
    const owner = document.createElement('div'); owner.style.cssText = 'height:100px;width:200px;overflow:auto'; owner.innerHTML = '<div style="height:1000px">Reading</div>'; document.body.append(owner)
    owner.scrollTop = 50
    window.Motion.scroll(owner, () => 800)
    await new Promise(resolve => setTimeout(resolve, 80))
    const before = owner.scrollTop
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await new Promise(resolve => setTimeout(resolve, 80))
    return { before, after: owner.scrollTop, running: owner.hasAttribute('data-motion-running') }
  })
  expect(result.before).toBeGreaterThan(50)
  expect(result.before).toBeLessThan(800)
  expect(result.after).toBe(result.before)
  expect(result.running).toBe(false)
})

test('late navigation cannot move a hidden reduced-motion document', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await runtime(page)
  const result = await page.evaluate(() => {
    const owner = document.createElement('div'); owner.style.cssText = 'height:100px;width:200px;overflow:auto'; owner.innerHTML = '<div style="height:1000px">Reading</div>'; document.body.append(owner)
    owner.scrollTop = 50
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    window.Motion.scroll(owner, () => 800)
    return { y: owner.scrollTop, running: owner.hasAttribute('data-motion-running') }
  })
  expect(result).toEqual({ y: 50, running: false })
})

test('retirement keeps the presented opacity and print releases the inert visual', async ({ page }) => {
  await runtime(page)
  const result = await page.evaluate(() => {
    const actor = document.createElement('div'); actor.style.cssText = 'opacity:.35;width:120px;height:40px'; actor.textContent = 'Departing words'; document.body.append(actor)
    window.Motion.retire(actor)
    const ghost = document.querySelector<HTMLElement>('[data-flow-retiring]')!
    const result = { removed: !actor.isConnected, opacity: Number(getComputedStyle(ghost).opacity), inert: ghost.inert }
    window.dispatchEvent(new Event('beforeprint'))
    return { ...result, ghostRemoved: !ghost.isConnected }
  })
  expect(result).toEqual({ removed: true, opacity: .35, inert: true, ghostRemoved: true })
})

test('retirement retains ancestor opacity once and skips fully faded actors', async ({ page }) => {
  await runtime(page)
  const samples = await page.evaluate(() => {
    const samples: Array<{ ancestor: number, effective: number, ghosts: number, detached: boolean }> = []
    const bodyOpacity = document.body.style.opacity
    document.body.style.opacity = '.6'
    for (const row of [false, true]) for (const ancestor of [.4, 0]) {
      const outer = document.createElement('div'), inner = document.createElement('div')
      outer.style.opacity = '.5'; inner.style.opacity = String(ancestor)
      inner.innerHTML = row ? '<table><tbody><tr style="opacity:.35"><td><span style="opacity:.5">Departing words</span></td></tr></tbody></table>'
        : '<div style="opacity:.35;width:120px;height:40px"><span style="opacity:.5">Departing words</span></div>'
      outer.append(inner); document.body.append(outer)
      const actor = inner.querySelector<HTMLElement>(row ? 'tr' : ':scope > div')!
      window.Motion.retire(actor)
      const ghosts = [...document.querySelectorAll<HTMLElement>('[data-flow-retiring]')]
      const ghost = ghosts[0]
      const effective = ghost ? Number(getComputedStyle(ghost).opacity) * Number(getComputedStyle(ghost.querySelector('span')!).opacity) * .6 : 0
      samples.push({ ancestor, effective, ghosts: ghosts.length, detached: !actor.isConnected })
      window.dispatchEvent(new Event('beforeprint')); outer.remove()
    }
    document.body.style.opacity = bodyOpacity
    return samples
  })
  for (const sample of samples) {
    expect(sample.detached).toBe(true)
    expect(sample.ghosts).toBe(sample.ancestor ? 1 : 0)
    expect(sample.effective).toBeCloseTo(.35 * .5 * sample.ancestor * .5 * .6, 6)
  }
})

test('retirement skips scrolled-out actors and keeps partial clips fixed during exit', async ({ page }) => {
  await runtime(page)
  const result = await page.evaluate(async () => {
    const owner = document.createElement('div'); owner.style.cssText = 'position:fixed;top:160px;left:100px;width:100px;height:100px;border:4px solid transparent;overflow:auto'
    owner.innerHTML = '<div style="width:300px;height:400px"><div style="width:200px;height:40px">Clipped departure</div></div>'
    document.body.append(owner)
    owner.scrollTop = 80; owner.scrollLeft = 20
    const outside = owner.firstElementChild!.firstElementChild as HTMLElement
    const originalBox = outside.getBoundingClientRect()
    window.Motion.retire(outside)
    const skipped = !document.querySelector('[data-flow-retiring]')
    const partial = document.createElement('div'); partial.style.cssText = 'width:200px;height:40px'; partial.textContent = 'Partial departure'
    owner.firstElementChild!.prepend(partial); owner.scrollTop = 20; owner.scrollLeft = 20
    const clip = owner.getBoundingClientRect()
    window.Motion.retire(partial)
    const ghost = document.querySelector<HTMLElement>('[data-flow-retiring]')!
    const visibleBounds = () => {
      const box = ghost.getBoundingClientRect(), insets = ghost.style.clipPath.match(/[\d.]+/g)!.map(Number)
      return { top: box.top + insets[0], right: box.right - insets[1], left: box.left + insets[3] }
    }
    const before = visibleBounds()
    await new Promise(resolve => setTimeout(resolve, 80))
    const after = visibleBounds()
    const result = { skipped, originallyInsideViewport: originalBox.top > 0, before, after, expected: { top: clip.top + owner.clientTop, left: clip.left + owner.clientLeft, right: clip.left + owner.clientLeft + owner.clientWidth } }
    window.dispatchEvent(new Event('beforeprint')); owner.remove()
    return result
  })
  expect(result.skipped).toBe(true)
  expect(result.originallyInsideViewport).toBe(true)
  for (const bounds of [result.before, result.after]) for (const edge of ['top', 'left', 'right'] as const) expect(bounds[edge]).toBeCloseTo(result.expected[edge], 1)
})

test('batch card and table departures keep every pre-mutation position', async ({ page }) => {
  await runtime(page)
  const samples = await page.evaluate(() => {
    const samples: Array<{ before: number, after: number, cellsBefore: number[], cellsAfter: number[], inert: boolean, detached: boolean }> = []
    for (const tableRows of [false, true]) {
      const parent = document.createElement(tableRows ? 'table' : 'div')
      parent.style.cssText = 'width:240px;border-collapse:collapse'
      parent.innerHTML = tableRows
        ? '<tbody><tr><td style="width:180px">First departure</td><td>One</td></tr><tr><td>Second departure</td><td>Two</td></tr><tr><td>Third departure</td><td>Three</td></tr></tbody>'
        : '<div>First departure</div><div>Second departure</div><div>Third departure</div>'
      document.body.append(parent)
      const root = (tableRows ? parent.firstElementChild : parent) as HTMLElement
      const actors = [...root.children] as HTMLElement[]
      actors.forEach(actor => { actor.style.height = '40px' })
      const positions = actors.map(actor => actor.getBoundingClientRect().top)
      const cellWidths = actors.map(actor => [...actor.querySelectorAll('td')].map(cell => cell.getBoundingClientRect().width))
      window.Motion.layout(root, () => actors.forEach(actor => window.Motion.retire(actor)))
      const ghosts = [...document.querySelectorAll<HTMLElement>('[data-flow-retiring]')]
      actors.forEach((actor, index) => {
        const ghost = ghosts.find(ghost => ghost.textContent === actor.textContent)!
        samples.push({ before: positions[index], after: ghost.getBoundingClientRect().top, cellsBefore: cellWidths[index], cellsAfter: [...ghost.querySelectorAll('td')].map(cell => cell.getBoundingClientRect().width), inert: ghost.inert, detached: !actor.isConnected })
      })
      window.dispatchEvent(new Event('beforeprint'))
      parent.remove()
    }
    return samples
  })
  expect(samples).toHaveLength(6)
  for (const sample of samples) {
    expect(Math.abs(sample.after - sample.before)).toBeLessThan(.5)
    sample.cellsBefore.forEach((width, index) => expect(Math.abs(sample.cellsAfter[index] - width)).toBeLessThan(.5))
    expect(sample).toMatchObject({ inert: true, detached: true })
  }
})

test('retiring a container freezes moving descendant geometry and opacity', async ({ page }) => {
  await runtime(page)
  const samples = await page.evaluate(async () => {
    const parent = document.createElement('div'); parent.style.cssText = 'width:240px;height:240px'
    parent.innerHTML = '<div data-key="entry" style="height:40px">Entering child</div><div data-key="layout" style="height:40px;transform:translateX(7px)">Moving child</div>'
    document.body.append(parent)
    const children = [...parent.children] as HTMLElement[]
    window.Motion.layout(parent, () => {
      const gap = document.createElement('div'); gap.style.height = '40px'; parent.prepend(gap)
    })
    window.Motion.reveal(children[0])
    await new Promise(resolve => setTimeout(resolve, 80))
    const presentation = (element: HTMLElement) => {
      const box = element.getBoundingClientRect()
      return { x: box.x, y: box.y, opacity: Number(getComputedStyle(element).opacity) }
    }
    const before = children.map(presentation)
    const moving = children.map(child => child.hasAttribute('data-motion-running'))
    window.Motion.retire(parent)
    const ghost = document.querySelector<HTMLElement>('[data-flow-retiring]')!
    return children.map((child, index) => ({ before: before[index], after: presentation(ghost.querySelector<HTMLElement>(`[data-key="${child.dataset.key}"]`)!), moving: moving[index] }))
  })
  for (const sample of samples) {
    expect(sample.moving).toBe(true)
    expect(Math.abs(sample.after.x - sample.before.x)).toBeLessThan(.5)
    expect(Math.abs(sample.after.y - sample.before.y)).toBeLessThan(.5)
    expect(sample.after.opacity).toBe(sample.before.opacity)
  }
  await settled(page)
  await expect(page.locator('[data-flow-retiring]')).toHaveCount(0)
})

test('guided scrolling stops when its destination actor departs', async ({ page }) => {
  await runtime(page)
  const result = await page.evaluate(async () => {
    const owner = document.createElement('div'); owner.style.cssText = 'height:100px;width:200px;overflow:auto'
    owner.innerHTML = '<div style="height:1000px"><div style="height:40px;margin-top:600px">Destination</div></div>'
    document.body.append(owner)
    const actor = owner.firstElementChild!.firstElementChild as HTMLElement
    window.Motion.scrollToActor(actor, 'center')
    await new Promise(resolve => setTimeout(resolve, 80))
    const before = owner.scrollTop
    actor.remove()
    await new Promise(resolve => setTimeout(resolve, 80))
    return { before, after: owner.scrollTop, running: owner.hasAttribute('data-motion-running') }
  })
  expect(result.before).toBeGreaterThan(0)
  expect(result.after).toBe(result.before)
  expect(result.running).toBe(false)
})

test('forced settlement cannot navigate to a destination that just detached or hid', async ({ page }) => {
  await runtime(page)
  const results = await page.evaluate(async () => {
    const results: Array<{ before: number, after: number, running: boolean }> = []
    for (const lifecycle of ['resize', 'beforeprint', 'finish']) for (const departure of ['detach', 'hide']) {
      const owner = document.createElement('div'); owner.style.cssText = 'height:100px;width:200px;overflow:auto'
      owner.innerHTML = '<div style="height:1000px"><div style="height:40px;margin-top:600px">Destination</div></div>'; document.body.append(owner)
      const actor = owner.firstElementChild!.firstElementChild as HTMLElement
      window.Motion.scrollToActor(actor, 'center')
      await new Promise(resolve => setTimeout(resolve, 80))
      const before = owner.scrollTop
      if (departure === 'detach') actor.remove(); else actor.hidden = true
      if (lifecycle === 'finish') window.Motion.finishMotion(); else window.dispatchEvent(new Event(lifecycle))
      results.push({ before, after: owner.scrollTop, running: owner.hasAttribute('data-motion-running') })
      owner.remove()
    }
    return results
  })
  for (const result of results) {
    expect(result.before).toBeGreaterThan(0)
    expect(result.after).toBe(result.before)
    expect(result.running).toBe(false)
  }
})

test('retained popup controls become inert at logical close', async ({ page }) => {
  await runtime(page)
  const result = await page.evaluate(async () => {
    const panel = document.createElement('aside'); panel.hidden = true; panel.style.cssText = 'width:200px;height:100px'
    panel.innerHTML = '<button>Retiring control</button>'; document.body.append(panel)
    window.Motion.watchPanel(panel, () => !panel.hidden)
    panel.hidden = false
    await new Promise(resolve => setTimeout(resolve, 80))
    panel.hidden = true
    await new Promise<void>(resolve => queueMicrotask(resolve))
    panel.querySelector('button')!.focus()
    return { inert: panel.inert, presented: !!panel.getClientRects().length, focused: panel.contains(document.activeElement) }
  })
  expect(result).toEqual({ inert: true, presented: true, focused: false })
})

test('a popup closed by CSS class retains its presented flex layout until exit', async ({ page }) => {
  await runtime(page)
  const result = await page.evaluate(async () => {
    const panel = document.createElement('aside'); panel.id = 'behavior-triggers-panel'; panel.className = 'open'
    panel.innerHTML = '<button>First control</button><button>Second control</button>'; document.body.append(panel)
    window.Motion.watchPanel(panel, () => panel.classList.contains('open'))
    const before = panel.getBoundingClientRect().height
    panel.classList.remove('open')
    await new Promise<void>(resolve => queueMicrotask(resolve))
    return { before, after: panel.getBoundingClientRect().height, inert: panel.inert, display: getComputedStyle(panel).display }
  })
  expect(result.after).toBe(result.before)
  expect(result).toMatchObject({ inert: true, display: 'flex' })
  await settled(page)
  await expect(page.locator('#behavior-triggers-panel')).toBeHidden()
})

test('table retirement applies actor opacity once', async ({ page }) => {
  await runtime(page)
  const opacity = await page.evaluate(() => {
    const table = document.createElement('table'); table.innerHTML = '<tbody><tr style="opacity:.35"><td>Departing row</td></tr></tbody>'; document.body.append(table)
    window.Motion.retire(table.querySelector('tr')!)
    const ghost = document.querySelector<HTMLElement>('[data-flow-retiring]')!
    return Number(getComputedStyle(ghost).opacity) * Number(getComputedStyle(ghost.querySelector('tr')!).opacity)
  })
  expect(opacity).toBe(.35)
})

test('question editors survive temporarily duplicated editable answer IDs', async ({ page }) => {
  await runtime(page)
  await page.evaluate(() => {
    const builder = window.Builder.createJevBuilder({ models: async () => [], changed: () => undefined, evaluate: () => undefined, preview: () => undefined, example: () => undefined, template: () => undefined })
    builder.set(builder.draft)
    document.body.append(builder.el)
  })
  await page.locator('.jev-builder [data-add="choice"]').click()
  const editors = page.locator('.jev-question')
  await expect(editors).toHaveCount(2)
  const ids = page.getByRole('textbox', { name: 'Answer ID', exact: true })
  const original = await ids.first().inputValue()
  await ids.nth(1).fill(original)
  await page.locator('.jev-builder [data-action="add-option"]').click()
  await expect(editors).toHaveCount(2)
  await expect(ids.nth(0)).toHaveValue(original)
  await expect(ids.nth(1)).toHaveValue(original)
  await ids.nth(1).fill('corrected')
  await page.locator('.jev-builder [data-action="add-option"]').click()
  await expect(editors).toHaveCount(2)
  await expect(ids.nth(1)).toHaveValue('corrected')
})

test('closing question controls stay inert when the builder rerenders', async ({ page }) => {
  await runtime(page)
  const result = await page.evaluate(() => {
    const builder = window.Builder.createJevBuilder({ models: async () => [], changed: () => undefined, evaluate: () => undefined, preview: () => undefined, example: () => undefined, template: () => undefined })
    builder.set(builder.draft); document.body.append(builder.el)
    const question = builder.el.querySelector<HTMLDetailsElement>('.jev-question')!
    const body = question.querySelector<HTMLElement>('.jev-question-body')!
    question.querySelector<HTMLElement>('summary')!.click()
    builder.el.querySelector<HTMLButtonElement>('[data-format="json"]')!.click()
    const field = body.querySelector<HTMLInputElement>('[data-field="id"]')!
    field.focus()
    return { open: question.open, hidden: body.hidden, inert: body.inert, presented: !!body.getClientRects().length, focused: document.activeElement === field }
  })
  expect(result).toEqual({ open: false, hidden: true, inert: true, presented: true, focused: false })
  await settled(page)
})

test('removing an earlier choice keeps the remaining edited options and controls', async ({ page }) => {
  await runtime(page)
  await page.evaluate(() => {
    const builder = window.Builder.createJevBuilder({ models: async () => [], changed: () => undefined, evaluate: () => undefined, preview: () => undefined, example: () => undefined, template: () => undefined })
    builder.set(builder.draft); document.body.append(builder.el)
  })
  await page.getByRole('combobox', { name: 'Primitive', exact: true }).selectOption('choice')
  await page.locator('[data-action="add-option"]').click()
  const names = page.getByRole('textbox', { name: 'Option name', exact: true })
  for (const [index, name] of ['Alpha', 'Beta', 'Gamma'].entries()) await names.nth(index).fill(name)
  const second = await names.nth(1).elementHandle()
  await page.locator('.jev-option [data-action="remove-option"]').first().click()
  await expect(names).toHaveCount(2)
  await expect(names.nth(0)).toHaveValue('Beta')
  await expect(names.nth(1)).toHaveValue('Gamma')
  expect(await second!.evaluate(element => element === document.querySelector('[data-field="option-name"]'))).toBe(true)
})

test('native request disclosure keeps its model suggestions hidden during opening', async ({ page }) => {
  await runtime(page)
  await page.evaluate(() => {
    const builder = window.Builder.createJevBuilder({ models: async () => [{ name: 'jev-latest', description: 'Stable model' }], changed: () => undefined, evaluate: () => undefined, preview: () => undefined, example: () => undefined, template: () => undefined })
    builder.set(builder.draft); document.body.append(builder.el)
  })
  const field = page.locator('.jev-advanced .jev-field')
  const display = await field.evaluate(element => getComputedStyle(element).display)
  await page.locator('.jev-advanced > summary').click()
  expect(await field.evaluate(element => getComputedStyle(element).display)).toBe(display)
  expect(await page.locator('.jev-advanced datalist').evaluate(async element => {
    let visible = false
    await new Promise<void>(resolve => {
      const start = performance.now()
      const frame = () => { visible ||= !!element.getClientRects().length; if (performance.now() - start < 800) requestAnimationFrame(frame); else resolve() }
      requestAnimationFrame(frame)
    })
    return visible
  })).toBe(false)
  await expect(page.getByRole('combobox', { name: 'JEV model', exact: true })).toBeVisible()
  const exit = await field.evaluate(element => {
    const details = element.closest('details')!
    const before = element.getBoundingClientRect().height
    details.querySelector<HTMLElement>('summary')!.click()
    return { before, after: element.getBoundingClientRect().height, open: details.open, inert: (element as HTMLElement).inert }
  })
  expect(exit.open).toBe(false)
  expect(exit.inert).toBe(true)
  expect(exit.after).toBe(exit.before)
  await settled(page)
  await expect(field).toBeHidden()
})

test('reordered results retain each question’s native distribution state', async ({ page }) => {
  await runtime(page)
  const result = await page.evaluate(() => {
    const answer: import('../../src/jev-types').JevAnswer = { type: 'choice', choice: 'Yes', probabilities: { Yes: .75, No: .25 }, confidence: .5 }
    const run: import('../../src/jev-types').JevRun = { id: 'fixture', sessionId: 'fixture', status: 'completed', startedAt: '2026-10-13T10:00:00Z',
      request: { model: 'jev-latest', state: 'Browser fixture', questions: { First: { type: 'choice', instructions: 'First question' }, Second: { type: 'choice', instructions: 'Second question' } } },
      result: { model: 'jev-latest', answers: { First: answer, Second: answer }, usage: { input_tokens: 0, output_tokens: 0 } } }
    const container = document.createElement('section'); container.innerHTML = window.Results.renderJevRun(run); document.body.append(container)
    const first = [...container.querySelectorAll('article')].find(card => card.querySelector('strong')?.textContent === 'First')!
    first.querySelector('details')!.open = false
    run.result!.answers = { Second: answer, First: answer }
    window.Patch.patchContent(container, window.Results.renderJevRun(run))
    return [...container.querySelectorAll('article')].map(card => ({ question: card.querySelector('strong')!.textContent, open: card.querySelector('details')!.open, retained: card === first }))
  })
  expect(result).toEqual([{ question: 'Second', open: true, retained: false }, { question: 'First', open: false, retained: true }])
})

test('animation frames batch geometry reads before writing row styles', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium exposes the performance counters used by this regression.')
  await runtime(page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  await page.evaluate(() => {
    const root = document.createElement('div'); root.id = 'frame-batch'; root.style.cssText = 'position:fixed;top:0;left:0;width:240px'
    root.innerHTML = '<div style="height:4px">Row</div>'.repeat(80); document.body.append(root)
    for (const actor of root.children) window.Motion.reveal(actor as HTMLElement)
  })
  const before = await cdp.send('Performance.getMetrics')
  await page.evaluate(() => new Promise<void>(resolve => {
    let frames = 0
    const sample = () => {
      if (++frames < 12) { requestAnimationFrame(sample); return }
      // Stop at the sampled boundary; CDP delivery time must not count extra
      // animation frames when other browser tests keep the runner busy.
      window.Motion.finishMotion(document.getElementById('frame-batch')!)
      resolve()
    }
    requestAnimationFrame(sample)
  }))
  const after = await cdp.send('Performance.getMetrics')
  const layouts = (metrics: typeof before) => metrics.metrics.find(metric => metric.name === 'LayoutCount')!.value
  expect(layouts(after) - layouts(before)).toBeLessThan(25)
  const styles = (metrics: typeof before) => metrics.metrics.find(metric => metric.name === 'RecalcStyleCount')!.value
  expect(styles(after) - styles(before)).toBeLessThan(25)
})

test('collection layout measures all destinations before animating visible actors', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium exposes the performance counters used by this regression.')
  await runtime(page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  await page.evaluate(() => {
    const root = document.createElement('div'); root.id = 'layout-batch'; root.style.cssText = 'position:absolute;top:0;left:0;width:240px'
    root.innerHTML = '<div style="height:40px">Row</div>'.repeat(1300); document.body.append(root)
    root.getBoundingClientRect()
  })
  const before = await cdp.send('Performance.getMetrics')
  const actors = await page.evaluate(() => {
    const root = document.getElementById('layout-batch')!
    window.Motion.layout(root, () => root.prepend(root.lastElementChild!))
    return { total: root.children.length, moving: root.querySelectorAll('[data-motion-running]').length }
  })
  const after = await cdp.send('Performance.getMetrics')
  const layouts = (metrics: typeof before) => metrics.metrics.find(metric => metric.name === 'LayoutCount')!.value
  expect(actors.total).toBe(1300)
  expect(actors.moving).toBeGreaterThan(0)
  expect(actors.moving).toBeLessThan(25)
  expect(layouts(after) - layouts(before)).toBeLessThan(10)
})


test('view departure batches presentation reads before completing rows', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium exposes the performance counters used by this regression.')
  await runtime(page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  // Inspector round trips must not count intervening animation frames.
  await freeze(page)
  await page.evaluate(() => {
    const root = document.createElement('div'); root.id = 'finish-batch'; root.style.cssText = 'position:fixed;top:0;left:0;width:240px'
    root.innerHTML = '<div style="height:4px">Row</div>'.repeat(80); document.body.append(root)
    for (const actor of root.children) window.Motion.reveal(actor as HTMLElement)
  })
  const before = await cdp.send('Performance.getMetrics')
  // Exercise delayed driver delivery as well as an idle local inspector.
  await new Promise(resolve => setTimeout(resolve, 150))
  const active = await page.evaluate(() => {
    const root = document.getElementById('finish-batch')!
    const active = root.querySelectorAll('[data-motion-running]').length
    window.Motion.finishMotion(root, true)
    return active
  })
  const after = await cdp.send('Performance.getMetrics')
  const styles = (metrics: typeof before) => metrics.metrics.find(metric => metric.name === 'RecalcStyleCount')!.value
  console.log(JSON.stringify({ motionCompletion: { styleRecalculations: styles(after) - styles(before), active } }))
  expect(styles(after) - styles(before)).toBeLessThan(10)
  expect(active).toBe(80)
  await expect(page.locator('#finish-batch [data-motion-running]')).toHaveCount(0)
})


for (const reduced of [false, true]) test(`retained table controls preserve focus with reduced motion ${reduced}`, async ({ page }) => {
  if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' })
  await runtime(page)
  const focused = await page.evaluate(() => {
    const table = document.createElement('table'); table.style.cssText = 'position:fixed;top:0;left:0'
    table.innerHTML = '<tbody><tr><td><button>Retained control</button></td></tr></tbody>'; document.body.append(table)
    const body = table.tBodies[0], row = body.rows[0], button = row.querySelector('button')!
    button.focus()
    window.Motion.layout(body, () => {
      const fragment = document.createDocumentFragment(); fragment.append(row); body.append(fragment)
    })
    return document.activeElement === button && button.isConnected
  })
  expect(focused).toBe(true)
})

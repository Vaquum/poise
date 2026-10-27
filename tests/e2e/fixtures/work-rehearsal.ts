import { build } from 'esbuild'
import { expect, type Page } from '@playwright/test'
import type { RehearsalTableData } from '../../../src/views/work-rehearsal-table'
import type { mountWorkRehearsalTable } from '../../../src/views/work-rehearsal-table'

declare global {
  interface Window {
    PoiseWorkRehearsal: { mountWorkRehearsalTable: typeof mountWorkRehearsalTable }
    workRehearsalTable: ReturnType<typeof mountWorkRehearsalTable>
  }
}
let assets: Promise<{ js: string, css: string }> | undefined

/** Bundle the disconnected candidate component into the isolated browser fixture.
 *  The production entry and its defaults never import or mount it. */
export async function mountRehearsalTable(page: Page, data: RehearsalTableData): Promise<void> {
  assets ??= build({ entryPoints: ['src/views/work-rehearsal-table.ts', 'src/views/work-rehearsal-table.css'], bundle: true, write: false,
    outdir: 'work-rehearsal-assets', format: 'iife', globalName: 'PoiseWorkRehearsal' }).then(result => ({
      js: result.outputFiles.find(file => file.path.endsWith('.js'))!.text,
      css: result.outputFiles.find(file => file.path.endsWith('.css'))!.text,
    }))
  const bundle = await assets
  await page.route('**/__work-rehearsal.js', route => route.fulfill({ contentType: 'application/javascript', body: bundle.js }))
  await page.route('**/__work-rehearsal.css', route => route.fulfill({ contentType: 'text/css', body: bundle.css }))
  await expect(page.locator('#view-chat .chat-layout')).toBeVisible()
  await page.addStyleTag({ url: '/__work-rehearsal.css' })
  await page.addScriptTag({ url: '/__work-rehearsal.js' })
  await page.evaluate(input => {
    window.workRehearsalTable = window.PoiseWorkRehearsal.mountWorkRehearsalTable(document.getElementById('view-chat')!, input,
      id => [...document.querySelectorAll<HTMLElement>('.chat-session-item')].find(node => node.dataset.id === id)?.click())
  }, data)
}

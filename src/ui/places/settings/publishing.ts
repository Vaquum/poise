// Settings → Publishing (#556; SETTINGS.md, P1–P7): classic's publishing
// sites, copied without their stylesheet (classic/publishing-settings.ts).
import { publishingSection, type PublishingSection } from './classic/publishing-settings'
import { putAway } from './keep'
import type { SectionDef } from './types'

let section: PublishingSection | null = null

export const PUBLISHING: SectionDef = {
  key: 'publishing',
  name: 'Publishing',
  what: 'The sites Editor publishes to. Each is a GitHub repository whose publish.yaml says how it takes a post. Google Docs publishing uses the Google accounts under Accounts.',
  findText: 'publishing publish site sites publish.yaml repository describe google docs',
  mount: (body) => {
    section ??= publishingSection()
    body.append(section.element)
    void section.refresh()
    return () => { if (section) putAway(section.element) }
  },
}

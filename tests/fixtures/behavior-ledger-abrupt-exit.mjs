// Opens a real ledger store in this process, captures one admission, then
// either closes cleanly or dies on SIGKILL without closing.
// Args: { storeBundle, path, mode: 'clean' | 'unclean' }.
import { createRequire } from 'node:module'

const { storeBundle, path, mode } = JSON.parse(process.argv[2])
const { BehaviorLedgerStore } = createRequire(import.meta.url)(storeBundle)
const db = new BehaviorLedgerStore(path)
db.capture({ type: 'admit', admissionKey: 'abrupt-panel', nativeId: 'abrupt-1', behavior: 'review-new-prs',
  source: 'poise:review-new-prs', owner: 'acme', actor: 'bot', repository: 'acme/project', number: 7,
  head: 'a'.repeat(40), slot: 'primary', plannedSlots: ['primary'] })
if (mode === 'clean') {
  db.close()
  console.log(JSON.stringify({ closed: true }))
} else {
  process.kill(process.pid, 'SIGKILL')
}

// Settings → Accounts (#556; SETTINGS.md, A1–A11): the sign-ins Poise acts
// with. The agent CLIs and gh, SSH keys, Google, Poise Link on your computers
// in service mode, and a terminal for what the buttons do not cover. Each
// part reads and acts on the routes classic's Accounts uses (src/settings.ts),
// drawn by the same renderers; a sign-in terminal opens under the row that
// asked for it, one at a time.
import { esc } from '../../dom'
import { ACCOUNT_IDS, ACCOUNT_LOGINS, MUSE_API_KEY_LOGIN, type ConnectedAccount } from '../../../../server/accounts/types'
import { isTerminalPreset, type TerminalPreset } from '../../../../server/terminal/protocol'
import type { SshKey } from '../../../../server/ssh-keys'
import { accountsHtml, fetchAccounts } from '../../../views/connected-accounts'
import { fetchSshKeys, sshKeysHtml } from '../../../views/ssh-keys'
import { googleAccountsSection } from '../../../views/google-accounts'
import { fetchGatewayAccount } from '../../../gateway-client'
import type { TerminalPanel } from '../../../views/terminal-panel'
import { poiseLinkSection, type PoiseLinkSection } from './classic/poise-link'
import type { Row } from './rows'
import type { SectionDef } from './types'

let accounts: ConnectedAccount[] | null = null
let accountErrors: string[] = []
let checking = new Set<string>()
let sshKeys: SshKey[] | null = null
let sshError: string | null = null
let terminal: TerminalPanel | null = null
let opening = false
let google: { el: HTMLElement, section: { refresh(): Promise<void> } } | null = null
let link: PoiseLinkSection | null = null

/** The sections whose accounts were read: a row is built again for Find and the counts. */
const read = new WeakSet<AbortSignal>()
const busy = (): boolean => opening || !!terminal?.running
function terminalTitle(preset: TerminalPreset): string {
  if (preset === 'shell') return 'Login shell'
  if (preset === 'muse-api-key') return MUSE_API_KEY_LOGIN.join(' ')
  if (preset === 'ssh-key') return 'Add an SSH key'
  return ACCOUNT_LOGINS[preset].join(' ')
}

export const ACCOUNTS: SectionDef = {
  key: 'accounts',
  name: 'Accounts',
  what: 'The sign-ins Poise acts with: the agent CLIs, GitHub and Google, and Poise Link on your computers.',
  load: async (ctx) => {
    if (ctx.service && !link) {
      const account = await fetchGatewayAccount().catch(() => null)
      if (account) link = poiseLinkSection(account)
    }
  },
  rows: (ctx) => {
    const identities = () => ({ me: String(ctx.known().me ?? ''), agentAccount: String(ctx.known().agentAccount ?? '') })
    const paintAgents = () => {
      const el = ctx.rows.rowEl('agents')?.querySelector<HTMLElement>('[data-accounts]')
      if (el && accounts) el.innerHTML = accountsHtml(accounts, identities(), busy())
      ctx.rows.lstat(agents, [checking.size ? `<span class="sdot"></span>Checking ${esc([...checking].join(', '))}…` : '', ...accountErrors.map((e) => `<span class="is-err">${esc(e)}</span>`)].filter(Boolean).join(' '))
      const ssh = ctx.rows.rowEl('ssh')?.querySelector<HTMLElement>('[data-ssh]')
      if (ssh) ssh.innerHTML = sshKeysHtml(sshKeys, sshError, busy())
      const shell = ctx.rows.rowEl('shell')?.querySelector<HTMLButtonElement>('[data-act="shell"]')
      if (shell) shell.setAttribute('aria-disabled', String(busy()))
    }
    async function readAccounts(): Promise<void> {
      accountErrors = []
      checking = new Set(ACCOUNT_IDS)
      paintAgents()
      await Promise.all(ACCOUNT_IDS.map(async (id) => {
        try {
          const next = await fetchAccounts(id)
          const account = next.find((a) => a.id === id)
          if (!account) throw new Error('the answer is missing this account')
          const byId = new Map((accounts ?? []).map((a) => [a.id, a]))
          byId.set(id, account)
          accounts = ACCOUNT_IDS.flatMap((key) => (byId.has(key) ? [byId.get(key)!] : []))
        } catch (error) {
          accountErrors.push(`Could not check ${id}: ${(error as Error).message}.`)
        } finally {
          checking.delete(id)
          if (!ctx.signal.aborted) paintAgents()
        }
      }))
    }
    async function readSsh(): Promise<void> {
      try { sshKeys = await fetchSshKeys(); sshError = null } catch (error) { sshError = `Could not check SSH keys: ${(error as Error).message}.` }
      if (!ctx.signal.aborted) paintAgents()
    }
    // A sign-in terminal opens under the row that asked for it.
    async function connect(preset: TerminalPreset, rowKey: string): Promise<void> {
      const slot = ctx.rows.rowEl(rowKey)?.querySelector<HTMLElement>('[data-term]')
      if (!slot) return
      if (busy()) { ctx.rows.lstat(ctx.rows.byKey(rowKey)!, '<span class="is-err">A terminal is already open here; finish or close it first.</span>'); terminal?.focus(); return }
      terminal?.dispose()
      opening = true
      paintAgents()
      try {
        const { openTerminal } = await import('../../../views/terminal-panel')
        const opened = openTerminal({
          preset, title: terminalTitle(preset),
          // A sign-in may have changed what the CLI says; an import may have added a key.
          onEnd: () => { paintAgents(); void readAccounts(); void readSsh() },
          onDispose: () => { if (terminal === opened) terminal = null; paintAgents() },
        })
        terminal = opened
        slot.append(opened.element)
        opened.element.scrollIntoView({ block: 'nearest' })
      } catch (error) {
        ctx.rows.lstat(ctx.rows.byKey(rowKey)!, `<span class="is-err">Could not open the terminal: ${esc((error as Error).message)}</span>`)
      } finally {
        opening = false
        paintAgents()
      }
    }
    const onConnect = (rowKey: string) => (el: HTMLElement) => el.addEventListener('click', (e) => {
      const preset = (e.target as Element).closest<HTMLElement>('[data-connect]')?.dataset.connect
      if (isTerminalPreset(preset)) void connect(preset, rowKey)
    }, { signal: ctx.signal })
    const agents: Row = {
      key: 'agents', ref: 'set.agents', group: 'Agents', label: 'AI accounts', type: 'custom', wide: true,
      gloss: 'One row per agent CLI, with what it signs in with, its state and its version. Connect opens its sign-in terminal under the row; one terminal at a time. gh’s GitHub accounts are listed too, with yours and the automation account marked.',
      findText: () => 'claude codex grok muse antigravity gh github sign in connect reconnect login cli',
      now: () => (accounts ? accounts.map((a) => `${a.id}: ${!a.installed ? 'not installed' : a.signedIn ? `signed in${a.identity ? ` as ${a.identity}` : ''}` : a.signedIn === false ? 'not signed in' : 'sign-in not reported'}`).join('; ') : ''),
      control: () => `<div class="set-acc" data-accounts>${accounts ? accountsHtml(accounts, identities(), busy()) : '<p class="fnote">Checking the accounts…</p>'}</div><div class="set-term" data-term></div>`,
      mounted: (el) => {
        onConnect('agents')(el)
        // Read once each time the section opens, as classic does when its tab is chosen.
        if (read.has(ctx.signal)) return
        read.add(ctx.signal)
        void readAccounts()
        void readSsh()
        // Elsewhere in Poise (the Claude sign-in strip) asks for a CLI's sign-in here.
        const wanted = ctx.query.get('connect')
        if (isTerminalPreset(wanted)) void connect(wanted, 'agents')
      },
    }
    const rows: Row[] = [
      agents,
      { key: 'ssh', ref: 'set.ssh', group: 'GitHub', label: 'SSH keys', type: 'custom', wide: true,
        gloss: 'The keys in ~/.ssh, by fingerprint. Poise lists public keys only and never reads a private key file. Add an SSH key opens a terminal under this row; the private key never leaves it.',
        findText: () => 'ssh key keys fingerprint ~/.ssh',
        control: () => `<div class="set-acc" data-ssh>${sshKeysHtml(sshKeys, sshError, busy())}</div><div class="set-term" data-term></div>`,
        mounted: (el) => onConnect('ssh')(el) },
      { key: 'google', ref: 'set.google', group: 'Google', label: 'Google accounts', type: 'custom', wide: true,
        gloss: 'The Google accounts Editor publishes documents to, each Connected or Needs sign-in. Unavailable until the operator enables Google.',
        findText: () => 'google docs drive account connect disconnect reconnect',
        control: () => '<div class="set-acc set-google" data-google></div>',
        mounted: (el) => {
          if (!google) { const host = document.createElement('div'); google = { el: host, section: googleAccountsSection(host) } }
          el.querySelector('[data-google]')?.append(google.el)
          void google.section.refresh()
        } },
    ]
    if (link) {
      const section = link
      rows.push({ key: 'link.pair', ref: 'set.link-pair', group: 'Poise Link', label: 'Poise Link', type: 'custom', wide: true,
        gloss: 'Poise Link on your computers: install it, approve the code it shows, and see the computers paired with this workspace.',
        findText: () => 'poise link pair pairing code approve deny computers devices revoke install',
        control: () => '<div class="set-acc set-link" data-link></div>',
        mounted: (el) => { el.querySelector('[data-link]')?.append(section.element); void section.refresh() } })
    }
    rows.push({ key: 'shell', ref: 'set.shell', group: 'Terminal', label: 'Terminal', type: 'custom', wide: true,
      gloss: 'A shell in your workspace for connections the buttons above do not cover. Two can run at once; an idle one closes after 15 minutes.',
      findText: () => 'terminal shell login',
      control: () => `<button type="button" class="btn-ghost" data-act="shell" data-ref="set.shell"${busy() ? ' aria-disabled="true"' : ''}>Open a shell</button><div class="set-term" data-term></div>`,
      act: (act) => { if (act === 'shell') void connect('shell', 'shell') } })
    return rows
  },
}

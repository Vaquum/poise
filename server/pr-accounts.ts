import { getMeta } from './db'

export function prAccounts(): { me: string, agent: string } {
  const me = getMeta('me') || ''
  const agent = getMeta('agentAccount') || ''
  if (!me || !agent) throw new Error('PR automation needs both your GitHub account and agent account. Set it in Settings → GitHub')
  if (me.toLowerCase() === agent.toLowerCase()) throw new Error('Your GitHub account and agent account must be different for PR review')
  return { me, agent }
}

/** Explicit manual reviews of third-party PRs retain the agent reviewer. */
export function prReviewer(author: string, manual = false): string {
  const { me, agent } = prAccounts()
  if (!author || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/.test(author)) throw new Error('PR author is missing or invalid')
  if (author.toLowerCase() === agent.toLowerCase()) return me
  if (manual || author.toLowerCase() === me.toLowerCase()) return agent
  throw new Error(`PR is authored by ${author}, outside your configured GitHub account pair`)
}

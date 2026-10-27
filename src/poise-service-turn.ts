// Where a Poise send goes when live self-update is off (service mode).
// Service mode never blocks a message: a natural-language match is sent as
// an ordinary turn unchanged, and an explicit `/poise` request is sent as an
// ordinary turn whose deliverable is a pull request against Poise, with a
// one-line note saying so. Local mode always takes the change route.
//
// Kept free of DOM imports so it runs under the node test environment.

import { POISE_REPOSITORY } from './poise-repository'
import type { PoiseCommand } from './self-update-command'

/** The one line Chat shows for an explicit /poise request sent where live self-update is off. */
export const SERVICE_POISE_NOTE = `Live self-update is off in service mode, so this goes through a PR against ${POISE_REPOSITORY} and ships with the next deployed image.`

/** An explicit /poise request framed as an ordinary turn whose deliverable is a PR against Poise.
 *  A model choice travels as the `/model` prefix, exactly as an ordinary send carries it, so the
 *  server runs the framed turn on the model the person chose. */
export function servicePoiseTurnText(request: string, model?: string): string {
  const body = `${request.trim()}\n\nLive Poise self-update is off in service mode: deliver this as a pull request against ${POISE_REPOSITORY}.`
  return model ? `/model ${model} ${body}` : body
}

export type PoiseTurnPlan =
  /** Start a live self-update change. */
  | { kind: 'change' }
  /** Send the message as an ordinary turn, unchanged. */
  | { kind: 'ordinary' }
  /** Send the framed request as an ordinary turn and show the note. */
  | { kind: 'service', text: string, note: string }

/** Route one Poise send. Only service mode diverts from the change route:
 *  a natural-language match sends unchanged, an explicit command sends
 *  framed for the PR path, keeping the person's model choice. */
export function planPoiseTurn(cmd: PoiseCommand, serviceMode: boolean, model?: string): PoiseTurnPlan {
  if (!serviceMode) return { kind: 'change' }
  if (cmd.form === 'natural') return { kind: 'ordinary' }
  return { kind: 'service', text: servicePoiseTurnText(cmd.request, model), note: SERVICE_POISE_NOTE }
}

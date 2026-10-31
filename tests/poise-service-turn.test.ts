import { describe, expect, it } from 'vitest'
import { POISE_REPOSITORY } from '../src/poise-repository'
import { SERVICE_POISE_NOTE, planPoiseTurn, servicePoiseTurnText } from '../src/poise-service-turn'

// Service mode never blocks a Chat message: live self-update is off, so a
// natural-language match sends as an ordinary turn unchanged and an explicit
// /poise request sends as an ordinary turn whose deliverable is a PR. Local
// mode keeps the live change route for every form.

describe('service-mode Poise turns', () => {
  it('keeps the change route for every form in local mode', () => {
    for (const form of ['slash', 'prefix', 'natural'] as const) {
      expect(planPoiseTurn({ request: 'Rename the Swarm view', form }, false)).toEqual({ kind: 'change' })
    }
  })

  it('sends a natural-language match unchanged as an ordinary turn in service mode', () => {
    expect(planPoiseTurn({ request: 'Investigate why autonomio/poise is slow', form: 'natural' }, true)).toEqual({ kind: 'ordinary' })
  })

  it('sends an explicit command as a framed turn with the one-line note in service mode', () => {
    for (const form of ['slash', 'prefix'] as const) {
      expect(planPoiseTurn({ request: 'Rename the Swarm view', form }, true)).toEqual({
        kind: 'service',
        text: servicePoiseTurnText('Rename the Swarm view'),
        note: SERVICE_POISE_NOTE,
      })
    }
  })

  it('frames the request so its deliverable is a PR against Poise', () => {
    const text = servicePoiseTurnText('  Rename the Swarm view  ')
    expect(text.startsWith('Rename the Swarm view\n\n')).toBe(true)
    expect(text).toContain(`pull request against ${POISE_REPOSITORY}`)
  })

  it('keeps a model choice as the /model prefix of the framed turn', () => {
    const text = servicePoiseTurnText('Rename the Swarm view', 'opus-5-max')
    expect(text.startsWith('/model opus-5-max Rename the Swarm view\n\n')).toBe(true)
    expect(text).toContain(`pull request against ${POISE_REPOSITORY}`)
    const plan = planPoiseTurn({ request: 'Rename the Swarm view', form: 'slash' }, true, 'opus-5-max')
    expect(plan).toEqual({ kind: 'service', text, note: SERVICE_POISE_NOTE })
  })

  it('keeps the note to one line naming the PR path and the next deploy', () => {
    expect(SERVICE_POISE_NOTE.split('\n')).toHaveLength(1)
    expect(SERVICE_POISE_NOTE).toContain('service mode')
    expect(SERVICE_POISE_NOTE).toContain(`PR against ${POISE_REPOSITORY}`)
    expect(SERVICE_POISE_NOTE).toContain('next deployed image')
  })
})

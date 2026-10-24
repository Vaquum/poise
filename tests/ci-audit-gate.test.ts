import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

interface WorkflowStep {
  name?: string
  id?: string
  if?: string
  run?: string
  env?: Record<string, string>
}

function loadWorkflow(path: string): any {
  return parseYaml(readFileSync(path, 'utf8'))
}

function staticSteps(ci: any): WorkflowStep[] {
  return ci?.jobs?.static?.steps as WorkflowStep[]
}

describe('CI audit gate', () => {
  it('audits only when package.json or package-lock.json changed', () => {
    const ci = loadWorkflow('.github/workflows/ci.yml')
    const steps = staticSteps(ci)
    expect(Array.isArray(steps)).toBe(true)

    const audit = steps.find(step => step.name === 'Audit dependencies')
    expect(audit).toBeDefined()
    expect(audit!.if ?? '').toContain("steps.deps.outputs.changed == 'true'")

    const detection = steps.find(step => step.id === 'deps')
    expect(detection).toBeDefined()
    expect(detection!.run ?? '').toContain('package.json')
    expect(detection!.run ?? '').toContain('package-lock.json')
    // Pull requests, the merge queue and main pushes each resolve a base.
    expect(detection!.env?.BASE ?? '').toContain('github.event.pull_request.base.sha')
    expect(detection!.env?.BASE ?? '').toContain('github.event.merge_group.base_sha')
    expect(detection!.env?.BASE ?? '').toContain('github.event.before')
  })

  it('keeps lint and typecheck unconditional', () => {
    const ci = loadWorkflow('.github/workflows/ci.yml')
    const steps = staticSteps(ci)
    const lint = steps.find(step => step.name === 'Lint')
    const typecheck = steps.find(step => step.name === 'Typecheck client, server and tests')
    expect(lint).toBeDefined()
    expect(lint!.if).toBeUndefined()
    expect(typecheck).toBeDefined()
    expect(typecheck!.if).toBeUndefined()
  })
})

describe('scheduled npm audit', () => {
  it('runs on a schedule and keeps one issue for new advisories on main', () => {
    const workflow = loadWorkflow('.github/workflows/npm-audit.yml')
    expect(workflow?.on?.schedule).toBeDefined()
    expect(workflow?.on?.workflow_dispatch).toBeDefined()
    expect(workflow?.permissions?.issues).toBe('write')

    const text = readFileSync('.github/workflows/npm-audit.yml', 'utf8')
    expect(text).toContain('npm audit --audit-level=high')
    expect(text).toContain('ref: main')
    // One fixed-title issue: create it, update it while advisories are open,
    // close it once the audit is clean again.
    expect(text).toContain('gh issue create')
    expect(text).toContain('gh issue edit')
    expect(text).toContain('gh issue close')
  })
})

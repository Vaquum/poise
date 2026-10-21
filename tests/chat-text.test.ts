import { describe, expect, it } from 'vitest'
import { deleteConfirmCopy, deleteRemovesWorkspace, queuedStatusText } from '../src/chat-text'
import type { SessionRecord } from '../server/chat/protocol'

const session = (overrides: Partial<SessionRecord> & { id: string }): SessionRecord => ({
  agent: 'grok',
  model: 'grok-4.6-high',
  modelId: 'grok-4.6',
  effort: 'high',
  repo: '',
  checkout: '/poise/.poise-chat/workers/11111111-1111-4111-8111-111111111111/workspace',
  workspaceKind: 'poise-local',
  branch: { name: `chat/${overrides.id}`, origin: 'new', provisional: true, baseSha: 'a'.repeat(40) },
  title: overrides.id,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: 'idle',
  capabilities: { steer: true, fork: true, thought: false, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false },
  lastSeq: 0,
  pendingRequests: [],
  instance: 'test',
  ...overrides,
} as SessionRecord)

describe('queued status text', () => {
  it('reads the agent-slot wait verbatim and checkout contention as queued behind', () => {
    expect(queuedStatusText('waiting for a free agent slot')).toBe('waiting for a free agent slot')
    expect(queuedStatusText('chat "Work" on chat/abc (Poise production)')).toBe('queued behind chat "Work" on chat/abc (Poise production)')
    expect(queuedStatusText(undefined)).toBe('queued behind another session')
  })
})

describe('delete confirmation preview', () => {
  const solo = session({ id: 'solo' })

  it('expects removal for a sole clean session on a provisioned workspace', () => {
    expect(deleteRemovesWorkspace(solo, [solo])).toBe(true)
    expect(deleteRemovesWorkspace({ ...solo, workspace: { currentBranch: solo.branch.name, onBranch: true, dirty: false, dirtyFiles: 0, checkedAt: '' } }, [solo])).toBe(true)
  })

  it('expects the workspace kept for anything shared, moved or dirty', () => {
    const sibling = session({ id: 'sibling', checkout: solo.checkout })
    expect(deleteRemovesWorkspace(solo, [solo, sibling])).toBe(false)
    expect(deleteRemovesWorkspace({ ...solo, checkout: '/poise/.poise-chat/workspace' }, [solo])).toBe(false)
    expect(deleteRemovesWorkspace({ ...solo, workspaceKind: undefined, repo: 'acme/repo', checkout: '/home/dev/repo' }, [solo])).toBe(false)
    expect(deleteRemovesWorkspace({ ...solo, branch: { ...solo.branch, origin: 'existing' } }, [solo])).toBe(false)
    expect(deleteRemovesWorkspace({ ...solo, branch: { ...solo.branch, provisional: false } }, [solo])).toBe(false)
    expect(deleteRemovesWorkspace({ ...solo, workspace: { currentBranch: solo.branch.name, onBranch: true, dirty: true, dirtyFiles: 1, checkedAt: '' } }, [solo])).toBe(false)
  })

  it('says which applies', () => {
    expect(deleteConfirmCopy(solo, [solo])).toEqual({
      title: 'Confirm delete (also removes its workspace)',
      label: 'Confirm deleting session (also removes its workspace)',
    })
    expect(deleteConfirmCopy({ ...solo, checkout: '/poise/.poise-chat/workspace' }, [solo])).toEqual({
      title: 'Confirm delete (keeps its workspace)',
      label: 'Confirm deleting session (keeps its workspace)',
    })
  })
})

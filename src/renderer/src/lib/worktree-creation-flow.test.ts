import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'

const { prepareEphemeralVmWorkspaceTargetMock } = vi.hoisted(() => ({
  prepareEphemeralVmWorkspaceTargetMock: vi.fn()
}))

const store = {
  settings: { activeRuntimeEnvironmentId: null as string | null },
  repos: [{ id: 'repo-runtime', connectionId: null }],
  pendingWorktreeCreations: {} as Record<string, PendingWorktreeCreation>,
  activePendingCreationId: null as string | null,
  beginPendingWorktreeCreation: vi.fn((entry: PendingWorktreeCreation) => {
    store.pendingWorktreeCreations[entry.creationId] = entry
    store.activePendingCreationId = entry.creationId
  }),
  updatePendingWorktreeCreation: vi.fn(
    (creationId: string, patch: Partial<PendingWorktreeCreation>) => {
      const entry = store.pendingWorktreeCreations[creationId]
      if (entry) {
        store.pendingWorktreeCreations[creationId] = { ...entry, ...patch }
      }
    }
  ),
  removePendingWorktreeCreation: vi.fn((creationId: string) => {
    delete store.pendingWorktreeCreations[creationId]
  }),
  setActiveView: vi.fn(),
  setSidebarOpen: vi.fn(),
  createWorktree: vi.fn(() => new Promise(() => {})),
  setupProjectExistingFolder: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: () => 'creation-1'
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn(() => false),
  ensureWorktreeHasInitialTerminal: vi.fn()
}))

vi.mock('@/lib/new-workspace-terminal-focus', () => ({
  queueNewWorkspaceTerminalFocus: vi.fn()
}))

vi.mock('@/lib/new-workspace', () => ({
  ensureAgentStartupInTerminal: vi.fn()
}))

vi.mock('@/lib/ephemeral-vm-workspace-target', () => ({
  prepareEphemeralVmWorkspaceTarget: prepareEphemeralVmWorkspaceTargetMock
}))

import { runBackgroundWorktreeCreation } from './worktree-creation-flow'

const FLOW_SOURCE = readFileSync(join(__dirname, 'worktree-creation-flow.ts'), 'utf8')

function makeRequest(overrides: Partial<WorktreeCreationRequest> = {}): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name: 'feature',
    setupDecision: 'inherit',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null,
    ...overrides
  }
}

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('runBackgroundWorktreeCreation', () => {
  beforeEach(() => {
    store.settings.activeRuntimeEnvironmentId = null
    store.repos = [{ id: 'repo-runtime', connectionId: null }]
    store.pendingWorktreeCreations = {}
    store.activePendingCreationId = null
    store.beginPendingWorktreeCreation.mockClear()
    store.updatePendingWorktreeCreation.mockClear()
    store.removePendingWorktreeCreation.mockClear()
    store.setActiveView.mockClear()
    store.setSidebarOpen.mockClear()
    store.createWorktree.mockReset().mockImplementation(() => new Promise(() => {}))
    store.setupProjectExistingFolder.mockReset()
    prepareEphemeralVmWorkspaceTargetMock.mockReset()
    globalThis.window = {
      api: {
        ephemeralVm: {
          attachWorkspace: vi.fn(),
          cleanup: vi.fn(),
          onProvisionEvent: vi.fn(() => vi.fn())
        }
      }
    } as never
  })

  it('uses the captured repo-owner progress mode instead of focused runtime state', () => {
    store.settings.activeRuntimeEnvironmentId = null
    store.beginPendingWorktreeCreation.mockClear()

    runBackgroundWorktreeCreation(makeRequest({ worktreeCreateProgressMode: 'indeterminate' }))

    expect(store.beginPendingWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        creationId: 'creation-1',
        indeterminate: true,
        request: expect.objectContaining({
          worktreeCreateProgressMode: 'indeterminate'
        })
      })
    )
  })

  it('falls back to focused runtime state for legacy captured requests', () => {
    store.settings.activeRuntimeEnvironmentId = 'focused-runtime'
    store.beginPendingWorktreeCreation.mockClear()

    runBackgroundWorktreeCreation(makeRequest())

    expect(store.beginPendingWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        indeterminate: true,
        request: expect.not.objectContaining({
          worktreeCreateProgressMode: expect.any(String)
        })
      })
    )
  })

  it('shows a VM provisioning phase and creates the worktree on the prepared runtime repo', async () => {
    prepareEphemeralVmWorkspaceTargetMock.mockResolvedValue({
      ok: true,
      runtimeId: 'runtime-1',
      environmentId: 'env-1',
      stderr: '',
      warnings: [],
      setup: {
        project: { id: 'project-1' },
        setup: {
          id: 'setup-runtime',
          projectId: 'project-1',
          hostId: 'runtime:env-1'
        },
        repo: { id: 'repo-runtime', path: '/workspace/repo' }
      }
    })
    store.createWorktree.mockResolvedValue({
      worktree: { id: 'repo-runtime::/workspace/repo/worktree', repoId: 'repo-runtime' }
    })

    runBackgroundWorktreeCreation(
      makeRequest({
        ephemeralVmRecipe: {
          sourceRepoId: 'repo-1',
          recipeId: 'cloud-sandbox',
          projectId: 'project-1'
        },
        worktreeCreateProgressMode: 'indeterminate'
      })
    )

    expect(store.beginPendingWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'provisioning-vm' })
    )
    await vi.waitFor(() => expect(store.createWorktree).toHaveBeenCalled())
    expect(prepareEphemeralVmWorkspaceTargetMock).toHaveBeenCalledWith({
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      projectId: 'project-1',
      workspaceName: 'feature',
      provisionId: 'creation-1',
      setupExistingFolder: store.setupProjectExistingFolder
    })
    const createCall = store.createWorktree.mock.calls[0] as unknown[]
    expect(createCall[0]).toBe('repo-runtime')
    expect(createCall[1]).toBe('feature')
    expect(createCall).toContain('creation-1')
    expect(window.api.ephemeralVm.attachWorkspace).toHaveBeenCalledWith({
      runtimeId: 'runtime-1',
      workspaceId: 'repo-runtime::/workspace/repo/worktree'
    })
  })

  it('appends stderr provisioning events for the active VM recipe create', async () => {
    let provisionEventCallback:
      | ((event: { provisionId: string; stream: 'stdout' | 'stderr'; chunk: string }) => void)
      | null = null
    const unsubscribe = vi.fn()
    window.api.ephemeralVm.onProvisionEvent = vi.fn((callback) => {
      provisionEventCallback = callback
      return unsubscribe
    })
    prepareEphemeralVmWorkspaceTargetMock.mockImplementation(async () => {
      provisionEventCallback?.({
        provisionId: 'creation-1',
        stream: 'stderr',
        chunk: 'creating sandbox\n'
      })
      provisionEventCallback?.({
        provisionId: 'other-create',
        stream: 'stderr',
        chunk: 'ignore me\n'
      })
      provisionEventCallback?.({
        provisionId: 'creation-1',
        stream: 'stdout',
        chunk: '{"pairingCode":"secret"}'
      })
      return {
        ok: true,
        runtimeId: 'runtime-1',
        environmentId: 'env-1',
        stderr: '',
        warnings: [
          {
            id: 'recipe.result.endpoint.public_ws',
            message: 'Recipe pairing endpoint uses insecure public ws:// transport.',
            remediation: 'Use wss://.'
          }
        ],
        setup: {
          project: { id: 'project-1' },
          setup: {
            id: 'setup-runtime',
            projectId: 'project-1',
            hostId: 'runtime:env-1'
          },
          repo: { id: 'repo-runtime', path: '/workspace/repo' }
        }
      }
    })
    store.createWorktree.mockResolvedValue({
      worktree: { id: 'repo-runtime::/workspace/repo/worktree', repoId: 'repo-runtime' }
    })

    runBackgroundWorktreeCreation(
      makeRequest({
        ephemeralVmRecipe: {
          sourceRepoId: 'repo-1',
          recipeId: 'cloud-sandbox',
          projectId: 'project-1'
        },
        worktreeCreateProgressMode: 'indeterminate'
      })
    )

    await vi.waitFor(() => expect(store.createWorktree).toHaveBeenCalled())
    expect(window.api.ephemeralVm.onProvisionEvent).toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalled()
    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith(
      'creation-1',
      expect.objectContaining({ provisioningLog: 'creating sandbox\n' })
    )
    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith(
      'creation-1',
      expect.objectContaining({
        provisioningLog: expect.stringContaining(
          'Warning: Recipe pairing endpoint uses insecure public ws:// transport.'
        )
      })
    )
    expect(JSON.stringify(store.updatePendingWorktreeCreation.mock.calls)).not.toContain(
      'pairingCode'
    )
    expect(JSON.stringify(store.updatePendingWorktreeCreation.mock.calls)).not.toContain(
      'ignore me'
    )
  })
})

describe('worktree creation flow agent trust preflight', () => {
  it('forwards the repo SSH connection id when pre-marking agent trust', () => {
    const preflight = sourceBetween(
      FLOW_SOURCE,
      'async function preflightAgentTrust',
      'async function executeWorktreeCreation'
    )
    const createFlow = sourceBetween(
      FLOW_SOURCE,
      'const backendSpawned = result.startupTerminal?.spawned === true',
      '// `createWorktree` already inserted the real worktree row'
    )

    expect(preflight).toContain('connectionId?: string | null')
    expect(preflight).toContain('...(connectionId ? { connectionId } : {})')
    expect(createFlow).toContain('repoConnectionId')
    expect(createFlow).toContain('repo.id === worktree.repoId')
    expect(createFlow).toContain(
      'await preflightAgentTrust(preparedRequest, worktree.path, repoConnectionId)'
    )
  })
})

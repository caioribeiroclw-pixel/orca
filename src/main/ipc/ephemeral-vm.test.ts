import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'

const handlers = new Map<string, (_event: unknown, args: never) => Promise<unknown> | unknown>()
const { handleMock, removeHandlerMock, getPathMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  getPathMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  },
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
}))

import { registerEphemeralVmHandlers } from './ephemeral-vm'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makePairingCode(): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint: 'wss://sandbox.example.com',
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  })
}

function makeStore(repoPath: string) {
  const repo = {
    id: 'repo-1',
    path: repoPath,
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 0
  }
  return {
    getRepo: vi.fn((repoId: string) => (repoId === 'repo-1' ? repo : null)),
    getRepos: vi.fn(() => [repo])
  }
}

function nodeCommand(scriptPath: string): string {
  return `"${process.execPath}" "${scriptPath}"`
}

describe('registerEphemeralVmHandlers', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    handlers.clear()
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    getPathMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: never) => {
      handlers.set(channel, handler)
    })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('lists recipes from local repo orca.yaml', async () => {
    const repoPath = makeDir('orca-ephemeral-vm-ipc-repo-')
    writeFileSync(
      join(repoPath, 'orca.yaml'),
      [
        'vmRecipes:',
        '  - id: cloud-sandbox',
        '    name: Cloud Sandbox',
        '    command: ./scripts/start.sh',
        '    cleanup: none'
      ].join('\n')
    )

    registerEphemeralVmHandlers(makeStore(repoPath) as never)
    const result = await handlers.get('ephemeralVm:listRecipes')?.(null, {
      repoId: 'repo-1'
    } as never)

    expect(removeHandlerMock).toHaveBeenCalledWith('ephemeralVm:listRecipes')
    expect(result).toEqual({
      status: 'ok',
      repoPath,
      diagnostics: [],
      recipes: [
        {
          id: 'cloud-sandbox',
          name: 'Cloud Sandbox',
          command: './scripts/start.sh',
          cleanupDisabled: true
        }
      ]
    })
  })

  it('lists the recipe catalog across local git repos', async () => {
    const repoPath = makeDir('orca-ephemeral-vm-ipc-repo-')
    writeFileSync(
      join(repoPath, 'orca.yaml'),
      [
        'vmRecipes:',
        '  - id: cloud-sandbox',
        '    name: Cloud Sandbox',
        '    command: ./scripts/start.sh',
        '    cleanup: none'
      ].join('\n')
    )

    registerEphemeralVmHandlers(makeStore(repoPath) as never)
    const result = await handlers.get('ephemeralVm:listRecipeCatalog')?.(null, undefined as never)

    expect(result).toEqual([
      {
        repoId: 'repo-1',
        repoName: 'Repo',
        repoPath,
        diagnostics: [],
        recipes: [
          {
            id: 'cloud-sandbox',
            name: 'Cloud Sandbox',
            command: './scripts/start.sh',
            cleanupDisabled: true
          }
        ]
      }
    ])
  })

  it('provisions a recipe and persists the ephemeral runtime', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-ipc-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-ipc-repo-')
    getPathMock.mockReturnValue(userDataPath)
    mkdirSync(join(repoPath, 'scripts'), { recursive: true })
    const startPath = join(repoPath, 'scripts', 'start.js')
    writeFileSync(
      startPath,
      [
        'console.log(JSON.stringify({',
        '  schemaVersion: 1,',
        `  pairingCode: ${JSON.stringify(makePairingCode())},`,
        "  projectRoot: '/workspace/repo',",
        '  userData: { providerResourceId: process.env.ORCA_VM_INSTANCE_ID }',
        '}))'
      ].join('\n')
    )
    writeFileSync(
      join(repoPath, 'orca.yaml'),
      [
        'vmRecipes:',
        '  - id: cloud-sandbox',
        '    name: Cloud Sandbox',
        `    command: ${JSON.stringify(nodeCommand(startPath))}`,
        '    cleanup: none'
      ].join('\n')
    )

    registerEphemeralVmHandlers(makeStore(repoPath) as never)
    const result = (await handlers.get('ephemeralVm:provision')?.(null, {
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      workspaceName: 'Fix Login Race'
    } as never)) as {
      ok: boolean
      runtime?: { id: string; repoId?: string; status?: string; runtimeEnvironmentId?: string }
      environment?: { id: string; name: string }
    }

    expect(result).toMatchObject({
      ok: true,
      environment: {
        name: expect.stringContaining('Repo VM ')
      },
      runtime: {
        repoId: 'repo-1',
        status: 'running',
        runtimeEnvironmentId: result.environment?.id
      }
    })
    const runtimes = await handlers.get('ephemeralVm:listRuntimes')?.(null, undefined as never)
    expect(runtimes).toEqual([
      expect.objectContaining({
        repoId: 'repo-1',
        recipeId: 'cloud-sandbox',
        runtimeEnvironmentId: result.environment?.id
      })
    ])

    const attached = await handlers.get('ephemeralVm:attachWorkspace')?.(null, {
      runtimeId: result.runtime?.id,
      workspaceId: 'repo-1::/workspace/repo/worktree'
    } as never)
    expect(attached).toEqual(
      expect.objectContaining({
        id: result.runtime?.id,
        workspaceId: 'repo-1::/workspace/repo/worktree'
      })
    )
  })

  it('returns a copyable cleanup command for a persisted runtime', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-ipc-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-ipc-repo-')
    getPathMock.mockReturnValue(userDataPath)
    mkdirSync(join(repoPath, 'scripts'), { recursive: true })
    const startPath = join(repoPath, 'scripts', 'start.js')
    const cleanupPath = join(repoPath, 'scripts', 'cleanup.js')
    writeFileSync(
      startPath,
      [
        'console.log(JSON.stringify({',
        '  schemaVersion: 1,',
        `  pairingCode: ${JSON.stringify(makePairingCode())},`,
        "  projectRoot: '/workspace/repo'",
        '}))'
      ].join('\n')
    )
    writeFileSync(cleanupPath, 'process.stdin.resume()\n')
    writeFileSync(
      join(repoPath, 'orca.yaml'),
      [
        'vmRecipes:',
        '  - id: cloud-sandbox',
        '    name: Cloud Sandbox',
        `    command: ${JSON.stringify(nodeCommand(startPath))}`,
        `    cleanup: ${JSON.stringify(nodeCommand(cleanupPath))}`
      ].join('\n')
    )

    registerEphemeralVmHandlers(makeStore(repoPath) as never)
    const provisioned = (await handlers.get('ephemeralVm:provision')?.(null, {
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      workspaceName: 'Fix Login Race'
    } as never)) as { ok: true; runtime: { id: string } }
    const result = await handlers.get('ephemeralVm:getCleanupCommand')?.(null, {
      runtimeId: provisioned.runtime.id
    } as never)

    expect(result).toMatchObject({
      runtimeId: provisioned.runtime.id,
      cleanupDisabled: false,
      payloadJson: expect.stringContaining('"workspaceName": "Fix Login Race"'),
      command: expect.stringContaining(nodeCommand(cleanupPath))
    })
  })

  it('streams provision logs and cancels an active provision', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-ipc-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-ipc-repo-')
    getPathMock.mockReturnValue(userDataPath)
    mkdirSync(join(repoPath, 'scripts'), { recursive: true })
    const startPath = join(repoPath, 'scripts', 'start.js')
    writeFileSync(
      startPath,
      [
        "process.stderr.write('creating sandbox\\n')",
        'setTimeout(() => {',
        '  console.log(JSON.stringify({',
        '    schemaVersion: 1,',
        `    pairingCode: ${JSON.stringify(makePairingCode())},`,
        "    projectRoot: '/workspace/repo'",
        '  }))',
        '}, 30000)'
      ].join('\n')
    )
    writeFileSync(
      join(repoPath, 'orca.yaml'),
      [
        'vmRecipes:',
        '  - id: cloud-sandbox',
        '    name: Cloud Sandbox',
        `    command: ${JSON.stringify(nodeCommand(startPath))}`,
        '    cleanup: none'
      ].join('\n')
    )

    registerEphemeralVmHandlers(makeStore(repoPath) as never)
    const sender = { send: vi.fn() }
    const provision = handlers.get('ephemeralVm:provision')?.({ sender }, {
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      workspaceName: 'Fix Login Race',
      provisionId: 'provision-1'
    } as never) as Promise<{ ok: boolean; error?: string }>

    await vi.waitFor(() =>
      expect(sender.send).toHaveBeenCalledWith('ephemeralVm:provisionEvent', {
        provisionId: 'provision-1',
        stream: 'stderr',
        chunk: 'creating sandbox\n'
      })
    )
    const cancelled = await handlers.get('ephemeralVm:cancelProvision')?.(null, {
      provisionId: 'provision-1'
    } as never)
    const result = await provision

    expect(cancelled).toEqual({ cancelled: true })
    expect(result.ok).toBe(false)
  })

  it('redacts recipe stdout when provisioning fails', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-ipc-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-ipc-repo-')
    getPathMock.mockReturnValue(userDataPath)
    mkdirSync(join(repoPath, 'scripts'), { recursive: true })
    const startPath = join(repoPath, 'scripts', 'start.js')
    writeFileSync(
      startPath,
      [
        'console.log(JSON.stringify({',
        `  pairingCode: ${JSON.stringify(makePairingCode())},`,
        "  token: 'provider-token'",
        '}))'
      ].join('\n')
    )
    writeFileSync(
      join(repoPath, 'orca.yaml'),
      [
        'vmRecipes:',
        '  - id: cloud-sandbox',
        '    name: Cloud Sandbox',
        `    command: ${JSON.stringify(nodeCommand(startPath))}`,
        '    cleanup: none'
      ].join('\n')
    )

    registerEphemeralVmHandlers(makeStore(repoPath) as never)
    const result = (await handlers.get('ephemeralVm:provision')?.(null, {
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox'
    } as never)) as { ok: false; stdout: string }

    expect(result.ok).toBe(false)
    expect(result.stdout).toContain('"pairingCode":"[redacted]"')
    expect(result.stdout).toContain('"token":"[redacted]"')
    expect(result.stdout).not.toContain('provider-token')
    expect(result.stdout).not.toContain('public-key')
  })
})

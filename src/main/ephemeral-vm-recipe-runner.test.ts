import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../shared/pairing'
import {
  buildEphemeralVmRecipeCleanupCommand,
  buildEphemeralVmRecipeCleanupPayload,
  runEphemeralVmRecipeCleanup,
  runEphemeralVmRecipeStart
} from './ephemeral-vm-recipe-runner'
import type { OrcaVmRecipe } from '../shared/types'

const tmpRoots: string[] = []

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-vm-recipe-runner-'))
  tmpRoots.push(root)
  return root
}

function makePairingCode(): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint: 'wss://sandbox.example.com',
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  })
}

function nodeCommand(scriptPath: string): string {
  return `"${process.execPath}" "${scriptPath}"`
}

describe('runEphemeralVmRecipeStart', () => {
  it('runs a recipe from the repo root and parses its JSON result', async () => {
    const repoPath = makeRepo()
    const scriptPath = join(repoPath, 'start.js')
    writeFileSync(
      scriptPath,
      [
        'console.error(`cwd:${process.cwd()}`)',
        'console.error(`instance:${process.env.ORCA_VM_INSTANCE_ID}`)',
        'console.log(JSON.stringify({',
        '  schemaVersion: 1,',
        `  pairingCode: ${JSON.stringify(makePairingCode())},`,
        "  projectRoot: '/workspace/repo',",
        '  userData: { providerResourceId: process.env.ORCA_VM_INSTANCE_ID }',
        '}))'
      ].join('\n')
    )

    const result = await runEphemeralVmRecipeStart({
      repoPath,
      recipe: {
        id: 'cloud-sandbox',
        name: 'Cloud Sandbox',
        command: nodeCommand(scriptPath)
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.context.recipeId).toBe('cloud-sandbox')
      expect(result.context.instanceId).toMatch(/^orca-/)
      expect(result.result.projectRoot).toBe('/workspace/repo')
      expect(result.result.userData).toEqual({ providerResourceId: result.context.instanceId })
      expect(result.stderr).toContain(`cwd:${realpathSync(repoPath)}`)
      expect(result.stderr).toContain(`instance:${result.context.instanceId}`)
    }
  })

  it('returns a parse failure when stdout is not the recipe result contract', async () => {
    const repoPath = makeRepo()
    const scriptPath = join(repoPath, 'start.js')
    writeFileSync(scriptPath, "console.log('Pairing URL: nope')\n")

    const result = await runEphemeralVmRecipeStart({
      repoPath,
      recipe: {
        id: 'cloud-sandbox',
        name: 'Cloud Sandbox',
        command: nodeCommand(scriptPath)
      },
      context: { instanceId: 'orca-test-instance' }
    })

    expect(result).toMatchObject({
      ok: false,
      error: 'Recipe stdout must be one JSON object.',
      exitCode: 0,
      signal: null,
      context: {
        instanceId: 'orca-test-instance',
        recipeId: 'cloud-sandbox',
        repoPath
      }
    })
  })

  it('returns a process failure when the recipe exits nonzero', async () => {
    const repoPath = makeRepo()
    const scriptPath = join(repoPath, 'start.js')
    writeFileSync(scriptPath, "console.error('boom')\nprocess.exit(7)\n")

    const result = await runEphemeralVmRecipeStart({
      repoPath,
      recipe: {
        id: 'cloud-sandbox',
        name: 'Cloud Sandbox',
        command: nodeCommand(scriptPath)
      }
    })

    expect(result).toMatchObject({
      ok: false,
      error: 'Recipe exited with code 7.',
      exitCode: 7,
      signal: null,
      stderr: 'boom\n'
    })
  })
})

describe('runEphemeralVmRecipeCleanup', () => {
  it('builds a copyable cleanup payload and command', () => {
    const repoPath = makeRepo()
    const recipe: OrcaVmRecipe = {
      id: 'cloud-sandbox',
      name: 'Cloud Sandbox',
      command: 'unused',
      cleanup: './scripts/orca-vm/cleanup.sh'
    }
    const payload = buildEphemeralVmRecipeCleanupPayload({
      recipe,
      context: {
        recipeId: 'cloud-sandbox',
        repoPath,
        instanceId: 'orca-test-instance',
        workspaceName: 'fix-login-race'
      },
      recipeResult: {
        schemaVersion: 1,
        pairingCode: makePairingCode(),
        projectRoot: '/workspace/repo'
      }
    })

    expect(payload).toMatchObject({
      schemaVersion: 1,
      mode: 'cleanup',
      recipeId: 'cloud-sandbox',
      instanceId: 'orca-test-instance',
      workspaceName: 'fix-login-race',
      recipeResult: { projectRoot: '/workspace/repo' }
    })
    expect(
      buildEphemeralVmRecipeCleanupCommand({
        cleanupCommand: recipe.cleanup!,
        payload
      })
    ).toContain('| ./scripts/orca-vm/cleanup.sh')
  })

  it('passes cleanup context and recipe result on stdin', async () => {
    const repoPath = makeRepo()
    const cleanupPath = join(repoPath, 'cleanup.js')
    writeFileSync(
      cleanupPath,
      [
        "let input = ''",
        "process.stdin.on('data', (chunk) => { input += chunk })",
        "process.stdin.on('end', () => {",
        '  const payload = JSON.parse(input)',
        '  console.log(JSON.stringify({',
        '    mode: payload.mode,',
        '    recipeId: payload.recipeId,',
        '    instanceId: payload.instanceId,',
        '    projectRoot: payload.recipeResult.projectRoot,',
        '    envMode: process.env.ORCA_VM_MODE,',
        '    envWorkspace: process.env.ORCA_WORKSPACE_NAME',
        '  }))',
        '})'
      ].join('\n')
    )
    const recipe: OrcaVmRecipe = {
      id: 'cloud-sandbox',
      name: 'Cloud Sandbox',
      command: 'unused',
      cleanup: nodeCommand(cleanupPath)
    }

    const result = await runEphemeralVmRecipeCleanup({
      repoPath,
      recipe,
      context: {
        recipeId: 'cloud-sandbox',
        repoPath,
        instanceId: 'orca-test-instance',
        workspaceName: 'fix-login-race'
      },
      recipeResult: {
        schemaVersion: 1,
        pairingCode: makePairingCode(),
        projectRoot: '/workspace/repo'
      }
    })

    if (!result.ok) {
      throw new Error(JSON.stringify(result))
    }
    expect(result.skipped).toBe(false)
    expect(JSON.parse(result.stdout)).toEqual({
      mode: 'cleanup',
      recipeId: 'cloud-sandbox',
      instanceId: 'orca-test-instance',
      projectRoot: '/workspace/repo',
      envMode: 'cleanup',
      envWorkspace: 'fix-login-race'
    })
  })

  it('skips cleanup when the recipe explicitly disables cleanup', async () => {
    const repoPath = makeRepo()

    const result = await runEphemeralVmRecipeCleanup({
      repoPath,
      recipe: {
        id: 'manual-sandbox',
        name: 'Manual Sandbox',
        command: 'unused',
        cleanupDisabled: true
      },
      context: {
        recipeId: 'manual-sandbox',
        repoPath,
        instanceId: 'orca-test-instance'
      },
      recipeResult: {
        schemaVersion: 1,
        pairingCode: makePairingCode(),
        projectRoot: '/workspace/repo'
      }
    })

    expect(result).toEqual({
      ok: true,
      skipped: true,
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: null
    })
  })
})

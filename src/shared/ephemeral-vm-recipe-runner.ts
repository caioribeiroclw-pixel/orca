import type { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import type { OrcaVmRecipe } from './types'
import { parseEphemeralVmRecipeResult, type EphemeralVmRecipeResult } from './ephemeral-vm-recipes'
import { quoteShellToken, runRecipeCommand } from './ephemeral-vm-recipe-process'

export type EphemeralVmRecipeContext = {
  instanceId?: string
  recipeId: string
  projectId?: string
  workspaceId?: string
  workspaceName?: string
  repoPath: string
  repoUrl?: string
  branch?: string
  ref?: string
  orcaVersion?: string
}

export type EphemeralVmRecipeStartArgs = {
  recipe: OrcaVmRecipe
  repoPath: string
  context?: Partial<Omit<EphemeralVmRecipeContext, 'recipeId' | 'repoPath'>>
  env?: NodeJS.ProcessEnv
  maxCaptureBytes?: number
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  spawnCommand?: typeof spawn
}

export type EphemeralVmRecipeStartSuccess = {
  ok: true
  context: EphemeralVmRecipeContext
  result: EphemeralVmRecipeResult
  stdout: string
  stderr: string
}

export type EphemeralVmRecipeStartFailure = {
  ok: false
  context: EphemeralVmRecipeContext
  error: string
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export type EphemeralVmRecipeStartResult =
  | EphemeralVmRecipeStartSuccess
  | EphemeralVmRecipeStartFailure

export type EphemeralVmRecipeCleanupArgs = {
  recipe: OrcaVmRecipe
  repoPath: string
  context: EphemeralVmRecipeContext
  recipeResult: EphemeralVmRecipeResult
  env?: NodeJS.ProcessEnv
  maxCaptureBytes?: number
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  spawnCommand?: typeof spawn
}

export type EphemeralVmRecipeCleanupResult = {
  ok: boolean
  skipped: boolean
  error?: string
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export type EphemeralVmRecipeCleanupPayload = {
  schemaVersion: 1
  mode: 'cleanup'
  recipeId: string
  instanceId?: string
  projectId?: string
  workspaceId?: string
  workspaceName?: string
  recipeResult: EphemeralVmRecipeResult
}

export async function runEphemeralVmRecipeStart(
  args: EphemeralVmRecipeStartArgs
): Promise<EphemeralVmRecipeStartResult> {
  validateRepoPath(args.repoPath)
  const context = buildRecipeContext(args.recipe, args.repoPath, args.context)
  const processResult = await runRecipeCommand({
    command: args.recipe.command,
    repoPath: args.repoPath,
    context,
    mode: 'create',
    env: args.env,
    maxCaptureBytes: args.maxCaptureBytes,
    signal: args.signal,
    onStdout: args.onStdout,
    onStderr: args.onStderr,
    spawnCommand: args.spawnCommand
  })

  if (processResult.exitCode !== 0) {
    return {
      ok: false,
      context,
      error: `Recipe exited with code ${processResult.exitCode ?? 'unknown'}.`,
      ...processResult
    }
  }

  const parsed = parseEphemeralVmRecipeResult(processResult.stdout)
  if (!parsed.ok) {
    return {
      ok: false,
      context,
      error: parsed.error,
      ...processResult
    }
  }

  return {
    ok: true,
    context,
    result: parsed.result,
    stdout: processResult.stdout,
    stderr: processResult.stderr
  }
}

export async function runEphemeralVmRecipeCleanup(
  args: EphemeralVmRecipeCleanupArgs
): Promise<EphemeralVmRecipeCleanupResult> {
  validateRepoPath(args.repoPath)
  if (args.recipe.cleanupDisabled || !args.recipe.cleanup) {
    return { ok: true, skipped: true, stdout: '', stderr: '', exitCode: null, signal: null }
  }

  const payload = buildEphemeralVmRecipeCleanupPayload(args)
  const processResult = await runRecipeCommand({
    command: args.recipe.cleanup,
    repoPath: args.repoPath,
    context: args.context,
    mode: 'cleanup',
    stdin: `${JSON.stringify(payload)}\n`,
    env: args.env,
    maxCaptureBytes: args.maxCaptureBytes,
    signal: args.signal,
    onStdout: args.onStdout,
    onStderr: args.onStderr,
    spawnCommand: args.spawnCommand
  })

  if (processResult.exitCode !== 0) {
    return {
      ok: false,
      skipped: false,
      error: `Cleanup exited with code ${processResult.exitCode ?? 'unknown'}.`,
      ...processResult
    }
  }

  return { ok: true, skipped: false, ...processResult }
}

export function buildEphemeralVmRecipeCleanupPayload(args: {
  recipe: Pick<OrcaVmRecipe, 'id'>
  context: EphemeralVmRecipeContext
  recipeResult: EphemeralVmRecipeResult
}): EphemeralVmRecipeCleanupPayload {
  return {
    schemaVersion: 1,
    mode: 'cleanup',
    recipeId: args.recipe.id,
    instanceId: args.context.instanceId,
    projectId: args.context.projectId,
    workspaceId: args.context.workspaceId,
    workspaceName: args.context.workspaceName,
    recipeResult: args.recipeResult
  }
}

export function buildEphemeralVmRecipeCleanupCommand(args: {
  cleanupCommand: string
  payload: EphemeralVmRecipeCleanupPayload
}): string {
  const payloadBase64 = Buffer.from(`${JSON.stringify(args.payload)}\n`, 'utf8').toString('base64')
  return [
    'node',
    '-e',
    quoteShellToken(
      `process.stdout.write(Buffer.from(${JSON.stringify(payloadBase64)}, 'base64').toString('utf8'))`
    ),
    '|',
    args.cleanupCommand
  ].join(' ')
}

function buildRecipeContext(
  recipe: OrcaVmRecipe,
  repoPath: string,
  context: EphemeralVmRecipeStartArgs['context'] = {}
): EphemeralVmRecipeContext {
  return {
    ...context,
    instanceId: context.instanceId ?? `orca-${randomUUID()}`,
    recipeId: recipe.id,
    repoPath
  }
}

function validateRepoPath(repoPath: string): void {
  const stat = statSync(repoPath)
  if (!stat.isDirectory()) {
    throw new Error(`Recipe repo path is not a directory: ${repoPath}`)
  }
}

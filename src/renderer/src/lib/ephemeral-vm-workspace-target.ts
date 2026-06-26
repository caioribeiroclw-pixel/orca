import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import type {
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult
} from '../../../shared/types'
import type { EphemeralVmRecipeResultWarning } from '../../../shared/ephemeral-vm-recipes'
import { PROJECT_HOST_SETUP_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { assertRuntimeEnvironmentCapability } from '@/runtime/runtime-rpc-client'

export type PrepareEphemeralVmWorkspaceTargetArgs = {
  repoId: string
  recipeId: string
  projectId: string
  workspaceName: string
  provisionId?: string
  setupExistingFolder: (
    args: ProjectHostSetupExistingFolderArgs
  ) => Promise<ProjectHostSetupResult | null>
}

export type PrepareEphemeralVmWorkspaceTargetResult =
  | {
      ok: true
      setup: ProjectHostSetupResult
      runtimeId: string
      environmentId: string
      stderr: string
      warnings: EphemeralVmRecipeResultWarning[]
    }
  | {
      ok: false
      error: string
      stderr: string
    }

export async function prepareEphemeralVmWorkspaceTarget(
  args: PrepareEphemeralVmWorkspaceTargetArgs
): Promise<PrepareEphemeralVmWorkspaceTargetResult> {
  const provisioned = await window.api.ephemeralVm.provision({
    repoId: args.repoId,
    recipeId: args.recipeId,
    projectId: args.projectId,
    workspaceName: args.workspaceName,
    ...(args.provisionId ? { provisionId: args.provisionId } : {})
  })
  if (!provisioned.ok) {
    return { ok: false, error: provisioned.error, stderr: provisioned.stderr }
  }

  try {
    await assertRuntimeEnvironmentCapability(
      provisioned.environment.id,
      PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
      'The recipe-created Orca server does not support project setup.'
    )
  } catch (error) {
    await cleanupProvisionedRuntime(provisioned.runtime.id)
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stderr: provisioned.stderr
    }
  }

  let setup: ProjectHostSetupResult | null
  try {
    setup = await args.setupExistingFolder({
      projectId: args.projectId,
      hostId: toRuntimeExecutionHostId(provisioned.environment.id),
      path: provisioned.runtime.recipeResult.projectRoot,
      setupMethod: 'imported-existing-folder'
    })
  } catch (error) {
    await cleanupProvisionedRuntime(provisioned.runtime.id)
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stderr: provisioned.stderr
    }
  }
  if (!setup) {
    await cleanupProvisionedRuntime(provisioned.runtime.id)
    return {
      ok: false,
      error: 'Failed to register the recipe-created project root on the runtime.',
      stderr: provisioned.stderr
    }
  }

  return {
    ok: true,
    setup,
    runtimeId: provisioned.runtime.id,
    environmentId: provisioned.environment.id,
    stderr: provisioned.stderr,
    warnings: provisioned.warnings
  }
}

async function cleanupProvisionedRuntime(runtimeId: string): Promise<void> {
  try {
    await window.api.ephemeralVm.cleanup({ runtimeId })
  } catch {
    // Best effort: the caller still needs the original setup/provisioning error.
  }
}

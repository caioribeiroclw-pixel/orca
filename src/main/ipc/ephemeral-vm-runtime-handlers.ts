import { app, ipcMain } from 'electron'
import type { Store } from '../persistence'
import { loadHooks } from '../hooks'
import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus
} from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { removeEnvironment } from '../../shared/runtime-environment-store'
import { cleanupEphemeralVmRuntime } from '../ephemeral-vm-runtime-service'
import {
  buildEphemeralVmRecipeCleanupCommand,
  buildEphemeralVmRecipeCleanupPayload
} from '../ephemeral-vm-recipe-runner'
import { getRecipeRepo, getRuntimeRecipeContext } from './ephemeral-vm-recipe-context'

export type EphemeralVmCleanupCommandResult = {
  runtimeId: string
  command: string | null
  payloadJson: string
  cleanupDisabled: boolean
  message?: string
}

export function registerEphemeralVmRuntimeHandlers(store: Store): void {
  ipcMain.removeHandler('ephemeralVm:attachWorkspace')
  ipcMain.removeHandler('ephemeralVm:listRuntimes')
  ipcMain.removeHandler('ephemeralVm:cleanup')
  ipcMain.removeHandler('ephemeralVm:getCleanupCommand')

  ipcMain.handle('ephemeralVm:listRuntimes', (): EphemeralVmRuntimeRecord[] => {
    return listEphemeralVmRuntimes(app.getPath('userData'))
  })

  ipcMain.handle(
    'ephemeralVm:attachWorkspace',
    (_event, args: { runtimeId: string; workspaceId: string }): EphemeralVmRuntimeRecord => {
      return updateEphemeralVmRuntimeStatus(app.getPath('userData'), args.runtimeId, {
        status: 'running',
        workspaceId: args.workspaceId
      })
    }
  )

  ipcMain.handle(
    'ephemeralVm:cleanup',
    async (_event, args: { runtimeId: string }): Promise<EphemeralVmRuntimeRecord> => {
      const userDataPath = app.getPath('userData')
      const runtime = listEphemeralVmRuntimes(userDataPath).find(
        (entry) => entry.id === args.runtimeId
      )
      if (!runtime) {
        throw new Error(`Unknown ephemeral VM runtime: ${args.runtimeId}`)
      }
      if (!runtime.repoId) {
        throw new Error(`Ephemeral VM runtime has no repo id: ${args.runtimeId}`)
      }
      const repo = getRecipeRepo(store, runtime.repoId)
      if (!repo.ok) {
        return updateEphemeralVmRuntimeStatus(userDataPath, runtime.id, {
          status: 'cleanup_failed',
          cleanupStatus: 'failed',
          cleanupLastAttemptAt: Date.now(),
          cleanupLastError: repo.message
        })
      }
      const recipe = (loadHooks(repo.repo.path)?.vmRecipes ?? []).find(
        (entry) => entry.id === runtime.recipeId
      )
      if (!recipe) {
        return updateEphemeralVmRuntimeStatus(userDataPath, runtime.id, {
          status: 'cleanup_failed',
          cleanupStatus: 'failed',
          cleanupLastAttemptAt: Date.now(),
          cleanupLastError: `Recipe not found: ${runtime.recipeId}`
        })
      }
      const result = await cleanupEphemeralVmRuntime({
        userDataPath,
        repoPath: repo.repo.path,
        recipe,
        runtimeId: runtime.id
      })
      if (result.ok && runtime.runtimeEnvironmentId) {
        try {
          removeEnvironment(userDataPath, runtime.runtimeEnvironmentId)
        } catch {
          // Cleanup of provider resources matters more than hiding a stale local
          // environment row; users can still remove that manually.
        }
      }
      return result.runtime
    }
  )

  ipcMain.handle(
    'ephemeralVm:getCleanupCommand',
    (_event, args: { runtimeId: string }): EphemeralVmCleanupCommandResult => {
      const userDataPath = app.getPath('userData')
      const resolved = getRuntimeRecipeContext(store, userDataPath, args.runtimeId)
      const payload = buildEphemeralVmRecipeCleanupPayload({
        recipe: resolved.recipe,
        context: {
          instanceId: resolved.runtime.id,
          recipeId: resolved.runtime.recipeId,
          projectId: resolved.runtime.projectId,
          workspaceId: resolved.runtime.workspaceId,
          workspaceName: resolved.runtime.workspaceName,
          repoPath: resolved.repo.repo.path
        },
        recipeResult: resolved.runtime.recipeResult
      })
      const payloadJson = JSON.stringify(payload, null, 2)
      if (resolved.recipe.cleanupDisabled || !resolved.recipe.cleanup) {
        return {
          runtimeId: resolved.runtime.id,
          command: null,
          payloadJson,
          cleanupDisabled: true,
          message: 'Cleanup is disabled for this recipe.'
        }
      }
      return {
        runtimeId: resolved.runtime.id,
        command: buildEphemeralVmRecipeCleanupCommand({
          cleanupCommand: resolved.recipe.cleanup,
          payload
        }),
        payloadJson,
        cleanupDisabled: false
      }
    }
  )
}

import { existsSync, statSync } from 'fs'
import { isAbsolute, join, normalize } from 'path'
import type {
  EphemeralVmRecipeDoctorCheck,
  EphemeralVmRecipeDoctorResult
} from './ephemeral-vm-recipes'
import type { OrcaVmRecipe } from './types'

export function doctorEphemeralVmRecipe(args: {
  repoPath: string
  recipeId: string
  recipes: readonly OrcaVmRecipe[]
  localExecutionSupported?: boolean
}): EphemeralVmRecipeDoctorResult {
  const checks: EphemeralVmRecipeDoctorCheck[] = []
  if (!args.localExecutionSupported) {
    checks.push({
      id: 'recipe.execution_target',
      status: 'fail',
      message: 'Ephemeral VM recipes run on the local desktop host in v1.',
      remediation: 'Use a local repo checkout for the recipe, or add remote recipe execution later.'
    })
    return buildDoctorResult(args.recipeId, args.repoPath, checks)
  }
  if (!existsSync(args.repoPath) || !statSync(args.repoPath).isDirectory()) {
    checks.push({
      id: 'repo.path',
      status: 'fail',
      message: `Repo path does not exist or is not a directory: ${args.repoPath}`,
      remediation: 'Pass the local repo that contains orca.yaml.'
    })
    return buildDoctorResult(args.recipeId, args.repoPath, checks)
  }

  const recipe = args.recipes.find((entry) => entry.id === args.recipeId)
  checks.push({
    id: 'recipe.exists',
    status: recipe ? 'pass' : 'fail',
    message: recipe
      ? `Found recipe "${recipe.name}".`
      : `Recipe "${args.recipeId}" was not found in vmRecipes.`,
    ...(recipe ? {} : { remediation: 'Check the recipe id or add it to vmRecipes.' })
  })
  if (!recipe) {
    return buildDoctorResult(args.recipeId, args.repoPath, checks)
  }

  checks.push(checkCommandPath(args.repoPath, recipe.command, 'recipe.command'))
  if (recipe.cleanupDisabled) {
    checks.push({
      id: 'recipe.cleanup',
      status: 'warn',
      message: 'Cleanup is explicitly disabled.',
      remediation: 'Only use cleanup: none when provider resources are cleaned up elsewhere.'
    })
  } else if (recipe.cleanup) {
    checks.push(checkCommandPath(args.repoPath, recipe.cleanup, 'recipe.cleanup'))
  } else {
    checks.push({
      id: 'recipe.cleanup',
      status: 'warn',
      message: 'No cleanup hook is configured.',
      remediation: 'Add cleanup or explicitly set cleanup: none.'
    })
  }

  return buildDoctorResult(args.recipeId, args.repoPath, checks)
}

export function firstRecipeCommandToken(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed) {
    return null
  }
  const quoted = trimmed.match(/^"([^"]+)"/) ?? trimmed.match(/^'([^']+)'/)
  if (quoted) {
    return quoted[1] ?? null
  }
  return trimmed.split(/\s+/)[0] ?? null
}

function checkCommandPath(
  repoPath: string,
  command: string,
  id: string
): EphemeralVmRecipeDoctorCheck {
  const executable = firstRecipeCommandToken(command)
  if (!executable) {
    return {
      id,
      status: 'fail',
      message: 'Command is empty.',
      remediation: 'Set a repo-relative command path.'
    }
  }
  if (isAbsolute(executable)) {
    return {
      id,
      status: 'warn',
      message: `Command uses an absolute path: ${executable}`,
      remediation: 'Prefer a repo-relative script so the recipe works across machines.'
    }
  }
  if (!executable.startsWith('./') && !executable.startsWith('.\\')) {
    return {
      id,
      status: 'warn',
      message: `Command is not a repo-relative path: ${executable}`,
      remediation: 'Use a repo-relative script such as ./scripts/orca-vm/start.sh.'
    }
  }
  const scriptPath = join(repoPath, normalize(executable))
  if (!existsSync(scriptPath)) {
    return {
      id,
      status: 'fail',
      message: `Command path does not exist: ${executable}`,
      remediation: 'Create the script or update the recipe command path.'
    }
  }
  return {
    id,
    status: 'pass',
    message: `Command path exists: ${executable}`
  }
}

function buildDoctorResult(
  recipeId: string,
  repoPath: string,
  checks: EphemeralVmRecipeDoctorCheck[]
): EphemeralVmRecipeDoctorResult {
  return {
    recipeId,
    repoPath,
    ok: checks.every((check) => check.status !== 'fail'),
    checks
  }
}

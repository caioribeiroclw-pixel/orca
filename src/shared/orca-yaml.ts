import { parse } from 'yaml'
import type {
  OrcaDefaultTabTemplate,
  OrcaHooks,
  OrcaVmRecipe,
  OrcaVmRecipeDiagnostic
} from './types'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

const DEFAULT_TAB_COLOR_RE = /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/
export const ORCA_VM_RECIPE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const ORCA_VM_RECIPE_ID_RULE =
  'Use 1-64 lowercase letters, numbers, dots, underscores, or hyphens, starting with a letter or number.'

function normalizeDefaultTabs(value: unknown): OrcaDefaultTabTemplate[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry) => {
      const record = asRecord(entry)
      if (!record) {
        return null
      }
      const title = asTrimmedString(record.title)
      const command = asTrimmedString(record.command)
      const color = asTrimmedString(record.color)
      const normalizedColor = color && DEFAULT_TAB_COLOR_RE.test(color) ? color : undefined
      if (!title && !command && !normalizedColor) {
        return null
      }
      return {
        ...(title ? { title } : {}),
        ...(normalizedColor ? { color: normalizedColor } : {}),
        ...(command ? { command } : {})
      }
    })
    .filter((entry): entry is OrcaDefaultTabTemplate => entry !== null)
}

type VmRecipeParseResult = {
  recipes: OrcaVmRecipe[]
  diagnostics: OrcaVmRecipeDiagnostic[]
}

function normalizeVmRecipes(value: unknown): VmRecipeParseResult {
  const diagnostics: OrcaVmRecipeDiagnostic[] = []
  if (!Array.isArray(value)) {
    return { recipes: [], diagnostics }
  }

  const seenIds = new Set<string>()
  const recipes = value
    .map((entry, index) => {
      const record = asRecord(entry)
      if (!record) {
        diagnostics.push({
          index,
          message: 'Recipe entry must be a mapping.'
        })
        return null
      }
      const id = asTrimmedString(record.id)
      const name = asTrimmedString(record.name)
      const command = asTrimmedString(record.command)
      if (!id) {
        diagnostics.push({ index, field: 'id', message: 'Recipe id is required.' })
        return null
      }
      if (!ORCA_VM_RECIPE_ID_PATTERN.test(id)) {
        diagnostics.push({
          index,
          field: 'id',
          message: `Invalid recipe id "${id}". ${ORCA_VM_RECIPE_ID_RULE}`
        })
        return null
      }
      if (seenIds.has(id)) {
        diagnostics.push({
          index,
          field: 'id',
          message: `Duplicate recipe id "${id}". Recipe ids must be unique.`
        })
        return null
      }
      if (!name) {
        diagnostics.push({ index, field: 'name', message: `Recipe "${id}" is missing name.` })
        return null
      }
      if (!command) {
        diagnostics.push({ index, field: 'command', message: `Recipe "${id}" is missing command.` })
        return null
      }
      seenIds.add(id)
      const description = asTrimmedString(record.description)
      const cleanupValue = asTrimmedString(record.cleanup)
      const cleanupDisabled = cleanupValue === 'none'
      return {
        id,
        name,
        command,
        ...(description ? { description } : {}),
        ...(cleanupValue && !cleanupDisabled ? { cleanup: cleanupValue } : {}),
        ...(cleanupDisabled ? { cleanupDisabled: true } : {})
      }
    })
    .filter((entry): entry is OrcaVmRecipe => entry !== null)
  return { recipes, diagnostics }
}

/**
 * Parse the supported project defaults from `orca.yaml`.
 */
export function parseOrcaYaml(content: string): OrcaHooks | null {
  let root: unknown
  try {
    root = parse(content)
  } catch {
    return null
  }

  const record = asRecord(root)
  if (!record) {
    return null
  }

  const scriptsRecord = asRecord(record.scripts)
  const setup = scriptsRecord ? asTrimmedString(scriptsRecord.setup) : undefined
  const archive = scriptsRecord ? asTrimmedString(scriptsRecord.archive) : undefined
  const issueCommand = asTrimmedString(record.issueCommand)
  const defaultTabs = normalizeDefaultTabs(record.defaultTabs)
  const vmRecipeParse = normalizeVmRecipes(record.vmRecipes)
  const vmRecipes = vmRecipeParse.recipes
  const vmRecipeDiagnostics = vmRecipeParse.diagnostics

  if (
    !setup &&
    !archive &&
    !issueCommand &&
    defaultTabs.length === 0 &&
    vmRecipes.length === 0 &&
    vmRecipeDiagnostics.length === 0
  ) {
    return null
  }

  return {
    scripts: {
      ...(setup ? { setup } : {}),
      ...(archive ? { archive } : {})
    },
    ...(issueCommand ? { issueCommand } : {}),
    ...(defaultTabs.length > 0 ? { defaultTabs } : {}),
    ...(vmRecipes.length > 0 ? { vmRecipes } : {}),
    ...(vmRecipeDiagnostics.length > 0 ? { vmRecipeDiagnostics } : {})
  }
}

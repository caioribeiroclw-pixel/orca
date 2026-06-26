import { z } from 'zod'
import { parsePairingCode } from './pairing'
export { doctorEphemeralVmRecipe, firstRecipeCommandToken } from './ephemeral-vm-recipe-doctor'
export {
  getEphemeralVmRecipeResultWarnings,
  redactEphemeralVmRecipeDiagnosticText,
  redactEphemeralVmRecipeResultForDiagnostics
} from './ephemeral-vm-recipe-diagnostics'
export type { EphemeralVmRecipeResultWarning } from './ephemeral-vm-recipe-diagnostics'

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema)
  ])
)

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export const EphemeralVmRecipeResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    pairingCode: z.string().min(1),
    projectRoot: z.string().min(1),
    userData: z.record(z.string(), JsonValueSchema).optional()
  })
  .strict()

export type EphemeralVmRecipeResult = z.infer<typeof EphemeralVmRecipeResultSchema>

export type EphemeralVmRecipeResultParseResult =
  | { ok: true; result: EphemeralVmRecipeResult }
  | { ok: false; error: string }

export type EphemeralVmRecipeDoctorCheckStatus = 'pass' | 'warn' | 'fail'

export type EphemeralVmRecipeDoctorCheck = {
  id: string
  status: EphemeralVmRecipeDoctorCheckStatus
  message: string
  remediation?: string
}

export type EphemeralVmRecipeDoctorResult = {
  recipeId: string
  repoPath: string
  ok: boolean
  checks: EphemeralVmRecipeDoctorCheck[]
}

export function parseEphemeralVmRecipeResult(stdout: string): EphemeralVmRecipeResultParseResult {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return { ok: false, error: 'Recipe produced no JSON result.' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, error: 'Recipe stdout must be one JSON object.' }
  }
  const result = EphemeralVmRecipeResultSchema.safeParse(parsed)
  if (!result.success) {
    return { ok: false, error: result.error.issues[0]?.message ?? 'Invalid recipe result.' }
  }
  if (!parsePairingCode(result.data.pairingCode)) {
    return { ok: false, error: 'Recipe result pairingCode is not a valid Orca pairing code.' }
  }
  if (!isAbsoluteRuntimePath(result.data.projectRoot)) {
    return { ok: false, error: 'Recipe result projectRoot must be an absolute runtime path.' }
  }
  return { ok: true, result: result.data }
}

export function isAbsoluteRuntimePath(path: string): boolean {
  return (
    path.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith('\\\\') ||
    path.startsWith('//')
  )
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { EphemeralVmRecipeContext } from './ephemeral-vm-recipe-runner'

const DEFAULT_MAX_CAPTURE_BYTES = 1024 * 1024

export type ProcessRunResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export function quoteShellToken(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replace(/(["^&|<>])/g, '^$1')}"`
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export async function runRecipeCommand(args: {
  command: string
  repoPath: string
  context: EphemeralVmRecipeContext
  mode: 'create' | 'cleanup'
  stdin?: string
  env?: NodeJS.ProcessEnv
  maxCaptureBytes?: number
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  spawnCommand?: typeof spawn
}): Promise<ProcessRunResult> {
  const maxBytes = args.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES
  const spawnCommand = args.spawnCommand ?? spawn

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnCommand(args.command, {
        cwd: args.repoPath,
        env: buildRecipeEnv(args.env, args.mode, args.context),
        shell: true,
        windowsHide: true
      }) as ChildProcessWithoutNullStreams
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const abort = (): void => {
      if (settled) {
        return
      }
      child.kill()
    }

    args.signal?.addEventListener('abort', abort, { once: true })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout = appendBounded(stdout, chunk, maxBytes)
      args.onStdout?.(chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = appendBounded(stderr, chunk, maxBytes)
      args.onStderr?.(chunk)
    })
    child.on('error', (error) => {
      settled = true
      args.signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.on('close', (exitCode, signal) => {
      settled = true
      args.signal?.removeEventListener('abort', abort)
      resolve({ stdout, stderr, exitCode, signal })
    })

    if (args.stdin) {
      child.stdin.end(args.stdin)
    } else {
      child.stdin.end()
    }
  })
}

function buildRecipeEnv(
  env: NodeJS.ProcessEnv | undefined,
  mode: 'create' | 'cleanup',
  context: EphemeralVmRecipeContext
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...env,
    ORCA_VM_MODE: mode,
    ORCA_VM_INSTANCE_ID: context.instanceId ?? '',
    ORCA_RECIPE_ID: context.recipeId,
    ORCA_PROJECT_ID: context.projectId ?? '',
    ORCA_WORKSPACE_ID: context.workspaceId ?? '',
    ORCA_WORKSPACE_NAME: context.workspaceName ?? '',
    ORCA_REPO_PATH: context.repoPath,
    ORCA_REPO_URL: context.repoUrl ?? '',
    ORCA_REPO_BRANCH: context.branch ?? '',
    ORCA_REPO_REF: context.ref ?? '',
    ORCA_VERSION: context.orcaVersion ?? ''
  }
}

function appendBounded(current: string, chunk: string, maxBytes: number): string {
  const next = current + chunk
  if (Buffer.byteLength(next, 'utf8') <= maxBytes) {
    return next
  }
  return next.slice(-maxBytes)
}

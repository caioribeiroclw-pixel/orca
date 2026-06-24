import {
  buildSetupRunnerCommand as buildSharedSetupRunnerCommand,
  getSetupRunnerCommandPlatformForPath
} from '../../../shared/setup-runner-command'

export function buildSetupRunnerCommand(runnerScriptPath: string): string {
  return buildSharedSetupRunnerCommand(
    runnerScriptPath,
    getSetupRunnerCommandPlatformForPath(
      runnerScriptPath,
      navigator.userAgent.includes('Windows') ? 'windows' : 'posix'
    )
  )
}

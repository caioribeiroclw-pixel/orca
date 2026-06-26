import { Loader2, RefreshCw, Server } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { OrcaHooks } from '../../../../shared/types'
import type { EphemeralVmRecipeDoctorResult } from '../../../../shared/ephemeral-vm-recipes'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { RecipeDoctorDialog } from './EphemeralVmRecipeDialogs'
import { EphemeralVmRecipeRow } from './EphemeralVmRecipeRow'
import { translate } from '@/i18n/i18n'
import {
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
  ensureOrcaCliAvailableForAgentSkillTerminal
} from '@/lib/agent-skill-cli-prerequisite'
import {
  EPHEMERAL_VMS_SKILL_INSTALL_COMMAND,
  EPHEMERAL_VMS_SKILL_NAME,
  EPHEMERAL_VMS_SKILL_UPDATE_COMMAND
} from '@/lib/agent-feature-install-commands'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import {
  buildSkillCommandForRuntime,
  ensureWslCliAvailableForAgentSkillTerminal,
  getWslCliDistroRequest
} from './CliSkillRuntimeSetup'

type RecipeCatalogEntry = Awaited<
  ReturnType<typeof window.api.ephemeralVm.listRecipeCatalog>
>[number]
type Recipe = NonNullable<OrcaHooks['vmRecipes']>[number]

export function EphemeralVmsPane(): React.JSX.Element {
  const openModal = useAppStore((state) => state.openModal)
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  const [catalog, setCatalog] = useState<RecipeCatalogEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [doctorResult, setDoctorResult] = useState<EphemeralVmRecipeDoctorResult | null>(null)
  const [doctorOpen, setDoctorOpen] = useState(false)
  const [doctorBusyKey, setDoctorBusyKey] = useState<string | null>(null)
  const mountedRef = useMountedRef()
  const installCommand =
    activeSkillRuntime.agentRuntime && !activeSkillRuntime.installDisabledReason
      ? buildSkillCommandForRuntime(
          EPHEMERAL_VMS_SKILL_INSTALL_COMMAND,
          activeSkillRuntime.agentRuntime
        )
      : EPHEMERAL_VMS_SKILL_INSTALL_COMMAND
  const updateCommand =
    activeSkillRuntime.agentRuntime && !activeSkillRuntime.installDisabledReason
      ? buildSkillCommandForRuntime(
          EPHEMERAL_VMS_SKILL_UPDATE_COMMAND,
          activeSkillRuntime.agentRuntime
        )
      : EPHEMERAL_VMS_SKILL_UPDATE_COMMAND
  const {
    installed: skillDetected,
    loading: skillLoading,
    error: skillError,
    refresh: refreshSkill
  } = useInstalledAgentSkill(EPHEMERAL_VMS_SKILL_NAME, {
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  const refresh = useCallback(async (): Promise<void> => {
    if (mountedRef.current) {
      setIsLoading(true)
    }
    try {
      const nextCatalog = await window.api.ephemeralVm.listRecipeCatalog()
      if (mountedRef.current) {
        setCatalog(nextCatalog)
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.EphemeralVmsPane.loadError',
                'Could not load VM recipes.'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setIsLoading(false)
      }
    }
  }, [mountedRef])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runDoctor = async (entry: RecipeCatalogEntry, recipe: Recipe): Promise<void> => {
    const key = `${entry.repoId}:${recipe.id}`
    setDoctorBusyKey(key)
    try {
      const result = await window.api.ephemeralVm.doctor({
        repoId: entry.repoId,
        recipeId: recipe.id
      })
      if (mountedRef.current) {
        setDoctorResult(result)
        setDoctorOpen(true)
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.EphemeralVmsPane.doctorError',
                'Could not run recipe doctor.'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setDoctorBusyKey(null)
      }
    }
  }

  const openWorkspaceComposerForRecipe = (repoId: string, recipeId: string): void => {
    openModal('new-workspace-composer', {
      initialRepoId: repoId,
      initialEphemeralVmRecipeId: recipeId,
      telemetrySource: 'settings'
    })
  }

  const recipes = catalog.flatMap((entry) => entry.recipes.map((recipe) => ({ entry, recipe })))

  return (
    <div className="space-y-6" data-settings-section="ephemeral-vms">
      <AgentSkillSetupPanel
        title={translate(
          'auto.components.settings.EphemeralVmsPane.skillTitle',
          'Ephemeral VMs skill'
        )}
        description={translate(
          'auto.components.settings.EphemeralVmsPane.skillDescription',
          'Helps agents author, review, debug, and validate repo-owned VM recipes.'
        )}
        command={installCommand}
        installedCommand={updateCommand}
        terminalTitle="Ephemeral VMs setup"
        terminalAriaLabel="Ephemeral VMs skill install terminal"
        terminalWorktreeId="settings-ephemeral-vms-skill-terminal"
        terminalShellOverride={activeSkillRuntime.terminalShellOverride}
        installed={skillDetected}
        loading={skillLoading}
        error={activeSkillRuntime.installDisabledReason ?? skillError}
        installDisabled={Boolean(activeSkillRuntime.installDisabledReason)}
        icon={<Server className="size-5" />}
        preInstallNotice={AGENT_SKILL_CLI_PREREQUISITE_NOTICE}
        getPrerequisiteStatus={() =>
          activeSkillRuntime.agentRuntime?.runtime === 'wsl'
            ? window.api.cli.getWslInstallStatus(
                getWslCliDistroRequest(activeSkillRuntime.agentRuntime)
              )
            : window.api.cli.getInstallStatus()
        }
        onBeforeOpenTerminal={async () => {
          await (activeSkillRuntime.agentRuntime?.runtime === 'wsl'
            ? ensureWslCliAvailableForAgentSkillTerminal(activeSkillRuntime.agentRuntime)
            : ensureOrcaCliAvailableForAgentSkillTerminal())
        }}
        onRecheck={refreshSkill}
      />

      <div className="space-y-3 rounded-lg border border-border/60 bg-card/30 p-4">
        <div className="space-y-1">
          <div className="text-sm font-medium">
            {translate(
              'auto.components.settings.EphemeralVmsPane.howItWorks',
              'How ephemeral VMs work'
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {translate(
              'auto.components.settings.EphemeralVmsPane.summary',
              'Ephemeral VMs are one-workspace remote runtimes. A repo-owned recipe runs locally, provisions whatever cloud sandbox you choose, starts orca serve there, and returns the pairing data Orca needs.'
            )}
          </p>
        </div>
        <div className="grid gap-3 text-sm sm:grid-cols-3">
          <InfoBlock
            title={translate('auto.components.settings.EphemeralVmsPane.recipeTitle', 'Recipe')}
            body={translate(
              'auto.components.settings.EphemeralVmsPane.recipeBody',
              'Defined in the repo orca.yaml. Your team owns the provider script and dependencies.'
            )}
          />
          <InfoBlock
            title={translate('auto.components.settings.EphemeralVmsPane.runtimeTitle', 'Runtime')}
            body={translate(
              'auto.components.settings.EphemeralVmsPane.runtimeBody',
              'Created when a workspace uses the recipe, then tracked until cleanup or deletion.'
            )}
          />
          <InfoBlock
            title={translate('auto.components.settings.EphemeralVmsPane.setupTitle', 'Setup')}
            body={translate(
              'auto.components.settings.EphemeralVmsPane.setupBody',
              'Create a normal local workspace for the repo, then ask your agent to use the Ephemeral VMs skill to add or debug the recipe.'
            )}
          />
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium">
              {translate('auto.components.settings.EphemeralVmsPane.recipes', 'Repo recipes')}
            </div>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.EphemeralVmsPane.recipesHelp',
                'Recipes discovered from local repos with vmRecipes in orca.yaml.'
              )}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={translate(
              'auto.components.settings.EphemeralVmsPane.refresh',
              'Refresh ephemeral VM recipes'
            )}
            onClick={() => void refresh()}
            disabled={isLoading}
          >
            {isLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        </div>

        <div className="rounded-lg border border-border/50 bg-card/30">
          {recipes.length === 0 ? (
            <div className="space-y-2 px-3 py-4 text-sm text-muted-foreground">
              <div>
                {isLoading
                  ? translate(
                      'auto.components.settings.EphemeralVmsPane.checking',
                      'Checking VM recipes...'
                    )
                  : translate(
                      'auto.components.settings.EphemeralVmsPane.none',
                      'No ephemeral VM recipes found.'
                    )}
              </div>
              <div className="text-xs">
                {translate(
                  'auto.components.settings.EphemeralVmsPane.noneHelp',
                  'Use the Ephemeral VMs skill from a normal repo workspace to add vmRecipes to orca.yaml, then refresh this page.'
                )}
              </div>
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {recipes.map(({ entry, recipe }) => (
                <EphemeralVmRecipeRow
                  key={`${entry.repoId}:${recipe.id}`}
                  entry={entry}
                  recipe={recipe}
                  doctorBusy={doctorBusyKey === `${entry.repoId}:${recipe.id}`}
                  onDoctor={() => void runDoctor(entry, recipe)}
                  onUse={() => openWorkspaceComposerForRecipe(entry.repoId, recipe.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <RecipeDoctorDialog open={doctorOpen} result={doctorResult} onOpenChange={setDoctorOpen} />
    </div>
  )
}

function InfoBlock({ title, body }: { title: string; body: string }): React.JSX.Element {
  return (
    <div className="space-y-1 rounded-md border border-border/50 bg-background/40 p-3">
      <div className="text-xs font-medium">{title}</div>
      <p className="text-xs text-muted-foreground">{body}</p>
    </div>
  )
}

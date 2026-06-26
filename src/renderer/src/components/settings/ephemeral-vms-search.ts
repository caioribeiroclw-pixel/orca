import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getEphemeralVmsSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate('auto.components.settings.ephemeralVms.search.title', 'Ephemeral VMs'),
    description: translate(
      'auto.components.settings.ephemeralVms.search.description',
      'Learn how repo-owned recipes create one temporary cloud runtime per workspace.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.ephemeralVms.search.keywordVm', 'vm'),
      ...translateSearchKeyword(
        'auto.components.settings.ephemeralVms.search.keywordSandbox',
        'sandbox'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.ephemeralVms.search.keywordCloud',
        'cloud'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.ephemeralVms.search.keywordRecipe',
        'recipe'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.ephemeralVms.search.keywordEphemeral',
        'ephemeral'
      )
    ]
  })
)

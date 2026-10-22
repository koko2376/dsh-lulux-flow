/**
 * Single source of truth for the plugin's names. Renaming the project means
 * editing this file, `package.json`, `cordis.patch.yml` and the client copy
 * of these constants (`client/src/brand.ts`).
 */
export const BRAND = {
  /** Display name in English UI and docs. */
  displayName: 'DSH-LULUX Flow',
  /** Display name in Chinese UI and docs. */
  displayNameZh: 'DSH工作流（LULUX Flow）',
  /** Plugin id: Cordis plugin name, HTTP namespace, data directory, tool prefix root. */
  id: 'dsh-lulux-flow',
  /** npm package name. */
  packageName: 'dsh-lulux-flow',
  /** Prefix for model-facing tools (`lulux_flow_workflow_run`, ...). */
  toolPrefix: 'lulux_flow',
  /** Prefix for subagent provider names (`lulux-flow-claude-code`, ...). */
  providerPrefix: 'lulux-flow',
  /** Prefix of minted gateway bearer tokens; makes leaked tokens greppable by secret scanners. */
  tokenPrefix: 'dshlf_',
  /** HTTP header names. */
  headers: {
    csrf: 'x-lulux-flow-request',
    signature: 'x-lulux-flow-signature',
    timestamp: 'x-lulux-flow-timestamp',
  },
} as const

/** Path prefix for the plugin's routes on the DSH web server. */
export const ROUTE_PREFIX = `/${BRAND.id}` as const

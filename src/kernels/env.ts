/**
 * Child-process environment for kernels.
 *
 * Scoped mode builds the environment from an allowlist: only variables a CLI
 * needs to run (PATH, HOME, locale, terminal, temp dirs, the Windows system
 * variables, proxy settings without credentials) are inherited, plus the
 * names the operator lists in `kernelEnvPassthrough`. The only credential the
 * child gets from LULUX Flow is its run-scoped gateway token, added by the
 * kernel adapter. Global mode keeps the user's environment (the CLI needs its
 * own login) but still removes DSH-internal variables.
 *
 * This keeps keys out of the environment only. A CLI running as your OS user
 * can still read files your user can read (see SECURITY.md).
 */

/** Exact names inherited in scoped mode (compared case-insensitively). */
const ALLOW_NAMES = new Set(
  [
    'PATH',
    'HOME',
    'USER',
    'USERNAME',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LANGUAGE',
    'TERM',
    'COLORTERM',
    'TZ',
    'TMPDIR',
    'TEMP',
    'TMP',
    'XDG_RUNTIME_DIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    // Windows
    'SYSTEMROOT',
    'SYSTEMDRIVE',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'APPDATA',
    'LOCALAPPDATA',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMW6432',
    'COMMONPROGRAMFILES',
    'COMMONPROGRAMFILES(X86)',
    'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS',
    'OS',
  ].map(name => name.toUpperCase()),
)

/** Prefixes inherited in scoped mode. */
const ALLOW_PREFIXES = ['LC_']

/** Proxy variables: inherited only without user:password in the URL. */
const PROXY_NAMES = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'])

/** Credential-shaped names, never inherited even if allowlisted by name pattern (passthrough excepted). */
export const CREDENTIAL_NAME = /(^|_)(API_?KEY|KEY|SECRET|TOKEN|AUTH_?TOKEN|PASSWORD|PASSWD|PAT|SK|CREDENTIALS?|AUTH)(_|$)|_AUTH|AUTHTOKEN|^NPM_CONFIG_/i

const ALWAYS_STRIP = ['DSH_', 'LULUX_FLOW_']

const LOOPBACK = '127.0.0.1,localhost,::1'

function withLoopbackNoProxy(env: Record<string, string>): void {
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const current = env[key]?.trim()
    env[key] = current ? `${current},${LOOPBACK}` : LOOPBACK
  }
}

/** True when a proxy URL carries credentials (user:pass@host). */
export function hasUserinfo(value: string): boolean {
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`)
    return url.username !== '' || url.password !== ''
  } catch {
    return /\/\/[^/@\s]+@/.test(value)
  }
}

export function scopedBaseEnv(source: NodeJS.ProcessEnv = process.env, passthrough: readonly string[] = []): Record<string, string> {
  const env: Record<string, string> = {}
  const extra = new Set(passthrough.map(name => name.trim().toUpperCase()).filter(Boolean))
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (ALWAYS_STRIP.some(prefix => upper.startsWith(prefix))) continue
    if (extra.has(upper)) {
      env[key] = value
      continue
    }
    if (PROXY_NAMES.has(upper)) {
      if (upper !== 'NO_PROXY' && hasUserinfo(value)) continue
      env[key] = value
      continue
    }
    const allowed = ALLOW_NAMES.has(upper) || ALLOW_PREFIXES.some(prefix => upper.startsWith(prefix))
    if (!allowed || CREDENTIAL_NAME.test(upper)) continue
    env[key] = value
  }
  withLoopbackNoProxy(env)
  env.NO_COLOR = '1'
  env.FORCE_COLOR = '0'
  return env
}

export function globalBaseEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (ALWAYS_STRIP.some(prefix => key.toUpperCase().startsWith(prefix))) continue
    env[key] = value
  }
  env.NO_COLOR = '1'
  env.FORCE_COLOR = '0'
  return env
}

const NPM_CONFIG_SECRET = /(_AUTH|AUTHTOKEN|TOKEN|PASSWORD|_PASS$|^NPM_CONFIG_KEY$|^NPM_CONFIG_CERT$|^NPM_CONFIG_EMAIL$|^NPM_CONFIG_\/\/)/i

/**
 * Environment for the npm steps of a CLI install. The same allowlist as a
 * scoped CLI (so provider keys never reach package lifecycle scripts), plus
 * what npm itself needs: proxy variables (including ones with credentials,
 * which npm needs to reach the registry) and non-secret `npm_config_*`
 * settings such as `cafile`, `cache` or `userconfig`.
 */
export function npmBaseEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = scopedBaseEnv(source)
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (ALWAYS_STRIP.some(prefix => upper.startsWith(prefix))) continue
    if (PROXY_NAMES.has(upper)) env[key] = value
    else if (upper.startsWith('NPM_CONFIG_') && !NPM_CONFIG_SECRET.test(upper)) env[key] = value
  }
  withLoopbackNoProxy(env)
  return env
}

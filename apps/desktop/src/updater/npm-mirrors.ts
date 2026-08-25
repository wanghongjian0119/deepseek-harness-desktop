/**
 * npm registry mirrors offered by the desktop Update Center.
 *
 * The source tarball still comes from GitHub; only pnpm/npm package installs
 * use the selected registry. Domestic mirrors cut install time on many CN
 * networks where registry.npmjs.org is slow or unstable.
 * @module @deepseek-ai/dsh-desktop/npm-mirrors
 */

/** One selectable npm registry mirror. */
export interface NpmMirror {
  /** Stable id stored with the Update Center selection. */
  id: string
  /** Human-readable label for the UI. */
  label: string
  /** Registry base URL (no trailing path beyond the registry root). */
  url: string
}

/** Built-in mirrors; the first entry is the Update Center default. */
export const NPM_MIRRORS: readonly NpmMirror[] = [
  { id: 'npmmirror', label: 'npmmirror（淘宝）', url: 'https://registry.npmmirror.com' },
  { id: 'tencent', label: '腾讯云', url: 'https://mirrors.cloud.tencent.com/npm/' },
  { id: 'huawei', label: '华为云', url: 'https://mirrors.huaweicloud.com/repository/npm/' },
  { id: 'official', label: 'npm 官方', url: 'https://registry.npmjs.org' },
]

/** Default mirror id when the UI has no saved preference. */
export const DEFAULT_NPM_MIRROR_ID = NPM_MIRRORS[0]?.id ?? 'npmmirror'

/**
 * Resolve a mirror id or raw URL to a registry base URL.
 * @param idOrUrl - a known mirror id, or an absolute `http(s)` registry URL.
 * @returns the registry URL to pass to pnpm/npm.
 */
export function resolveNpmRegistry(idOrUrl: string | undefined): string {
  if (idOrUrl === undefined || idOrUrl === '') {
    return NPM_MIRRORS.find(m => m.id === DEFAULT_NPM_MIRROR_ID)?.url ?? 'https://registry.npmmirror.com'
  }
  const byId = NPM_MIRRORS.find(m => m.id === idOrUrl)
  if (byId !== undefined) return byId.url
  if (/^https?:\/\//.test(idOrUrl)) return idOrUrl.replace(/\/$/, '')
  return NPM_MIRRORS.find(m => m.id === DEFAULT_NPM_MIRROR_ID)?.url ?? 'https://registry.npmmirror.com'
}

/**
 * Update availability check for the desktop shell.
 *
 * The official repository publishes no installers, tags, or releases — only
 * the `master` branch — so the update signal is the upstream master commit
 * SHA compared against the running payload's recorded `sourceRef`. The check
 * uses the public GitHub REST API; the repo is overridable through
 * `$DSH_DESKTOP_UPDATE_REPO` (e.g. a fork), and the API base is injectable
 * for tests.
 * @module @deepseek-ai/dsh-desktop/update-check
 */

/** The official upstream source repository. */
export const DEFAULT_UPDATE_REPO = 'deepseek-ai/deepseek-harness'

/** Options for {@link checkForUpdate}. */
export interface CheckForUpdateOptions {
  /** `owner/repo` to watch; defaults to the official upstream repository. */
  repo?: string
  /** The running payload's source ref; `undefined` disables the comparison. */
  currentSha?: string
  /** GitHub API base; defaults to `https://api.github.com`. */
  apiBase?: string
  /** Test hook for the HTTP fetch. */
  fetchImpl?: typeof fetch
}

/** The result of an update check. */
export interface UpdateCheckResult {
  repo: string
  currentSha: string | undefined
  latestSha: string | undefined
  /** True when a newer master commit exists and the payload records a ref. */
  available: boolean
}

/** Resolve the watched repository from the environment. */
export function updateRepo(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DSH_DESKTOP_UPDATE_REPO
  return override !== undefined && override !== '' ? override : DEFAULT_UPDATE_REPO
}

/**
 * Query the upstream master SHA and compare it with the running payload's.
 * @param options - repo, current ref, and HTTP hooks.
 * @returns the comparison result.
 * @throws on a failed API request.
 */
export async function checkForUpdate(options: CheckForUpdateOptions = {}): Promise<UpdateCheckResult> {
  const repo = options.repo ?? updateRepo()
  const fetchImpl = options.fetchImpl ?? fetch
  const base = options.apiBase ?? 'https://api.github.com'
  const response = await fetchImpl(`${base}/repos/${repo}/commits/master`, {
    headers: { 'User-Agent': 'dsh-desktop' },
  })
  if (!response.ok) {
    throw new Error(`update check failed for ${repo} (HTTP ${response.status})`)
  }
  const data = (await response.json()) as { sha?: unknown }
  const latestSha = typeof data.sha === 'string' && /^[0-9a-f]{40}$/.test(data.sha) ? data.sha : undefined
  const currentSha = options.currentSha
  return {
    repo,
    currentSha,
    latestSha,
    available: latestSha !== undefined && currentSha !== undefined && latestSha !== currentSha,
  }
}

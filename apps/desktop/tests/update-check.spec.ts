import { describe, expect, it, vi } from 'vitest'
import { checkForUpdate, DEFAULT_UPDATE_REPO, updateRepo } from '../src/updater/update-check.ts'

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

/** A fetch double returning a canned GitHub commits response. */
function fakeFetch(sha: string, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({ sha }), { status }))
}

describe('checkForUpdate', () => {
  it('reports available when the upstream SHA differs from the payload ref', async () => {
    const result = await checkForUpdate({ repo: 'owner/repo', currentSha: SHA, fetchImpl: fakeFetch(OTHER) })
    expect(result.available).toBe(true)
    expect(result.latestSha).toBe(OTHER)
  })

  it('reports no update when the SHAs match', async () => {
    const result = await checkForUpdate({ repo: 'owner/repo', currentSha: SHA, fetchImpl: fakeFetch(SHA) })
    expect(result.available).toBe(false)
  })

  it('reports no update without a payload ref', async () => {
    const result = await checkForUpdate({ repo: 'owner/repo', fetchImpl: fakeFetch(OTHER) })
    expect(result.available).toBe(false)
  })

  it('queries the master branch of the given repo', async () => {
    const fetchImpl = fakeFetch(SHA)
    await checkForUpdate({ repo: 'owner/repo', currentSha: SHA, fetchImpl, apiBase: 'https://api.example' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example/repos/owner/repo/commits/master',
      expect.objectContaining({ headers: { 'User-Agent': 'dsh-desktop' } }),
    )
  })

  it('defaults to the community Linux-desktop fork', () => {
    expect(DEFAULT_UPDATE_REPO).toBe('wanghongjian0119/deepseek-harness-desktop')
    expect(updateRepo({})).toBe(DEFAULT_UPDATE_REPO)
    expect(updateRepo({ DSH_DESKTOP_UPDATE_REPO: 'fork/repo' })).toBe('fork/repo')
  })

  it('throws on a failed API request', async () => {
    const fetchImpl = fakeFetch('', 403)
    await expect(checkForUpdate({ repo: 'owner/repo', currentSha: SHA, fetchImpl })).rejects.toThrow(/HTTP 403/)
  })

  it('ignores a malformed SHA from the API', async () => {
    const result = await checkForUpdate({ repo: 'owner/repo', currentSha: SHA, fetchImpl: fakeFetch('not-a-sha') })
    expect(result.latestSha).toBeUndefined()
    expect(result.available).toBe(false)
  })
})

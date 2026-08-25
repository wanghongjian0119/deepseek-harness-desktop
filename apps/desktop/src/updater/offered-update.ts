/**
 * Persist which upstream SHA the Update Center has already auto-opened for.
 *
 * Without this, every cold start re-opens the center whenever master is ahead
 * of the payload (the common case for a seeded install tracking official
 * master). Manual menu opens are unaffected.
 * @module @deepseek-ai/dsh-desktop/offered-update
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from '../payload.ts'

/** On-disk record under `$DSH_HOME/desktop/offered-update.json`. */
interface OfferedUpdateRecord {
  /** Upstream SHA last auto-offered in the Update Center. */
  offeredSha: string
}

/** Absolute path of the offered-update record for a harness home. */
export function offeredUpdatePath(home: string = dshHome()): string {
  return join(home, 'desktop', 'offered-update.json')
}

/**
 * Read the last auto-offered SHA, if any.
 * @param home - harness home; defaults to {@link dshHome}.
 * @returns the SHA, or `undefined` when missing/malformed.
 */
export function readOfferedUpdateSha(home: string = dshHome()): string | undefined {
  const path = offeredUpdatePath(home)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<OfferedUpdateRecord>
    if (typeof parsed.offeredSha === 'string' && /^[0-9a-f]{40}$/.test(parsed.offeredSha)) {
      return parsed.offeredSha
    }
  } catch {
    // Corrupt or unreadable record: treat as never offered.
  }
  return undefined
}

/**
 * Record that the Update Center has auto-opened for this upstream SHA.
 * @param sha - 40-hex git SHA.
 * @param home - harness home; defaults to {@link dshHome}.
 */
export function writeOfferedUpdateSha(sha: string, home: string = dshHome()): void {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`offered-update: invalid sha ${JSON.stringify(sha)}`)
  }
  const path = offeredUpdatePath(home)
  mkdirSync(dirname(path), { recursive: true })
  const record: OfferedUpdateRecord = { offeredSha: sha }
  writeFileSync(path, `${JSON.stringify(record)}\n`)
}

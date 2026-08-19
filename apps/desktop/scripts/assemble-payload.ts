/**
 * Build-time CLI for `apps/desktop/resources/dsh`: assemble the backend
 * payload from the current checkout. Runs the shared pipeline in
 * `src/payload-builder.ts` with the system pnpm (`pnpm dlx pnpm@<version>`),
 * a Node runtime downloaded from nodejs.org, and the checkout's git HEAD as
 * the recorded source ref.
 * @module @deepseek-ai/dsh-desktop/assemble-payload
 */

import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assemblePayload, dirSize } from '../src/payload-builder.ts'

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
/** pnpm deploy must run under the declared packageManager version. */
const PNPM_VERSION = '11.7.0'
/** Where the payload lands before electron-builder picks it up. */
const PAYLOAD_DIR = 'apps/desktop/resources/dsh'
/** Scratch staging under apps/desktop/.stage. */
const STAGE_DIR = 'apps/desktop/.stage'

/** The checkout's git HEAD, or undefined when git is unavailable. */
function gitHead(): string | undefined {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) return undefined
  const sha = result.stdout.trim()
  return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined
}

const outDir = join(root, PAYLOAD_DIR)
const sourceRef = gitHead()
await assemblePayload({
  sourceRoot: root,
  outDir,
  stageDir: join(root, STAGE_DIR),
  pnpmArgs: ['pnpm', 'dlx', `pnpm@${PNPM_VERSION}`],
  ...(sourceRef !== undefined ? { sourceRef } : {}),
})
const size = await dirSize(outDir)
console.log(`assemble-payload: ${outDir} (${(size / 1024 / 1024).toFixed(1)} MB)`)

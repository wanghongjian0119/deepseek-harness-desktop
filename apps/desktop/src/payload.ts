/**
 * Payload discovery for the DeepSeek Harness desktop shell.
 *
 * The payload is the self-contained backend assembled by
 * `scripts/assemble-payload.ts` into `apps/desktop/resources/dsh` (packaged
 * into the app bundle's `Resources/dsh` via electron-builder extraResources).
 * It carries the bundled Node runtime, the built dsh CLI, its hoisted
 * dependency closure, and the built frontend dist. The manifest records the
 * entry paths relative to the payload root, so the shell never hardcodes a
 * layout. A separate Node process cannot read asar, so the payload must stay
 * as real files — extraResources, not asar.
 *
 * The bundled payload is the seed. Source self-updates materialize new
 * payloads into a user-writable directory (`$DSH_HOME/desktop/payloads/<ref>`)
 * and flip the `current` pointer, because the app bundle itself is not
 * writable in a system install and the backend code must be replaceable
 * without reinstalling the shell.
 * @module @deepseek-ai/dsh-desktop/payload
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Schema marker for forward compatibility; bump on wire-layout changes. */
export const PAYLOAD_FORMAT = 1

/** Manifest filename inside the payload root. */
const PAYLOAD_MANIFEST_FILENAME = 'payload.json'

/** The payload manifest: entry paths relative to the payload root. */
export interface PayloadManifest {
  /** Schema marker; the shell refuses manifests it does not know. */
  format: number
  /** The dsh CLI entry (`lib/bin.js`), relative to the payload root. */
  cliEntry: string
  /** The bundled Node executable, relative to the payload root. */
  nodeBinary: string
  /** The upstream commit (or tag) this payload was built from, when known. */
  sourceRef?: string
}

/**
 * Read and validate the payload manifest.
 * @param root - the payload root directory.
 * @returns the parsed manifest.
 * @throws when the manifest is missing, malformed, or on an unknown format.
 */
export function readPayloadManifest(root: string): PayloadManifest {
  const raw = readFileSync(join(root, PAYLOAD_MANIFEST_FILENAME), 'utf8')
  const parsed = JSON.parse(raw) as Partial<PayloadManifest>
  if (parsed.format !== PAYLOAD_FORMAT) {
    throw new Error(`payload manifest format ${JSON.stringify(parsed.format)} is not supported (expected ${PAYLOAD_FORMAT})`)
  }
  if (typeof parsed.cliEntry !== 'string' || parsed.cliEntry === '') {
    throw new Error('payload manifest is missing cliEntry')
  }
  if (typeof parsed.nodeBinary !== 'string' || parsed.nodeBinary === '') {
    throw new Error('payload manifest is missing nodeBinary')
  }
  const manifest: PayloadManifest = { format: PAYLOAD_FORMAT, cliEntry: parsed.cliEntry, nodeBinary: parsed.nodeBinary }
  if (typeof parsed.sourceRef === 'string' && parsed.sourceRef !== '') manifest.sourceRef = parsed.sourceRef
  return manifest
}

/**
 * Resolve the DeepSeek Harness home directory: `$DSH_HOME` or `~/.dsh`.
 * Mirrors `@deepseek-ai/dsh-home-paths`' single-root precedence without
 * pulling a workspace dependency into the Electron shell.
 * @param env - the environment; defaults to `process.env`.
 * @returns the absolute harness home.
 */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DSH_HOME
  if (explicit !== undefined && explicit !== '') return explicit
  return join(homedir(), '.dsh')
}

/** Directory holding every user-installed payload, keyed by source ref. */
export function payloadsDir(home: string): string {
  return join(home, 'desktop', 'payloads')
}

/** Pointer file naming the active user-installed payload ref. */
function currentPointerPath(home: string): string {
  return join(payloadsDir(home), 'current')
}

/** A payload ref is a git SHA or tag — safe as a single path segment. */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Read the active payload ref from the pointer file, if any. */
export function readCurrentPointer(home: string): string | undefined {
  const path = currentPointerPath(home)
  if (!existsSync(path)) return undefined
  const ref = readFileSync(path, 'utf8').trim()
  return ref === '' || !REF_PATTERN.test(ref) ? undefined : ref
}

/**
 * Atomically switch the active payload ref: write a temp file, then rename
 * over the pointer. A crash between the two leaves the previous pointer
 * intact.
 * @param home - the harness home.
 * @param ref - the new active ref; must match {@link REF_PATTERN}.
 */
export function switchCurrentPointer(home: string, ref: string): void {
  if (!REF_PATTERN.test(ref)) throw new Error(`invalid payload ref ${JSON.stringify(ref)}`)
  const path = currentPointerPath(home)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${ref}\n`)
  renameSync(tmp, path)
}

/**
 * Resolve the payload root for this run.
 *
 * Precedence: `$DSH_DESKTOP_PAYLOAD` (dev/test override), the user-installed
 * payload named by the `current` pointer, then the bundled seed
 * (`resources/dsh` in packaged mode, `.stage/dsh` under the invoking
 * directory in dev).
 * @param packagedRoot - the bundled payload root, or `undefined` in dev.
 * @param env - the environment; defaults to `process.env`.
 * @param cwd - the invoking directory; defaults to `process.cwd()`.
 * @param home - the harness home; defaults to {@link dshHome}.
 * @returns the payload root, or `undefined` when none exists.
 */
export function resolvePayloadRoot(
  packagedRoot: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  home: string = dshHome(env),
): string | undefined {
  const explicit = env.DSH_DESKTOP_PAYLOAD
  if (explicit !== undefined && explicit !== '' && existsSync(join(explicit, PAYLOAD_MANIFEST_FILENAME))) {
    return explicit
  }
  const current = readCurrentPointer(home)
  if (current !== undefined) {
    const installed = join(payloadsDir(home), current)
    if (existsSync(join(installed, PAYLOAD_MANIFEST_FILENAME))) return installed
  }
  if (packagedRoot !== undefined && existsSync(join(packagedRoot, PAYLOAD_MANIFEST_FILENAME))) return packagedRoot
  const staged = join(cwd, '.stage', 'dsh')
  return existsSync(join(staged, PAYLOAD_MANIFEST_FILENAME)) ? staged : undefined
}

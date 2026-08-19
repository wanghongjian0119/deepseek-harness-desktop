/**
 * Source self-update for the desktop shell.
 *
 * The official repository publishes no installers — only `master` — so an
 * update downloads the upstream tarball, bootstraps the declared pnpm on the
 * bundled Node, installs and builds the checkout, assembles a new payload
 * (reusing the running payload's Node executable instead of downloading one),
 * boot-smokes it, and atomically flips the `current` pointer. The old payload
 * directory is left in place until the next successful update; the swap only
 * happens after the new payload boots and serves the GUI manifest.
 *
 * The build tree is kept under the work directory and removed after a
 * successful swap; on failure it is left for inspection and the error names
 * its path. pnpm runs in a closed environment with a store under the work
 * directory so a root-owned global store (a common `sudo pnpm` leftover)
 * cannot fail the install, and the last subprocess lines are attached to
 * the thrown error (the desktop launcher discards Electron stdout).
 * @module @deepseek-ai/dsh-desktop/update-job
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assemblePayload } from '../payload-builder.ts'
import { payloadsDir, switchCurrentPointer } from '../payload.ts'

/** pnpm fallback when the source manifest has no packageManager field. */
export const DEFAULT_PNPM_VERSION = '11.7.0'

/** Progress stages of one update run. */
type UpdateStage = 'download-source' | 'extract' | 'install' | 'build' | 'assemble' | 'finalize'

/** One progress event; `detail` is a short human-readable line. */
export interface UpdateProgress {
  stage: UpdateStage
  detail: string
}

/** Options for {@link runSourceUpdate}. */
export interface RunSourceUpdateOptions {
  /** `owner/repo` to fetch; must match the repository checked at runtime. */
  repo: string
  /** The upstream commit to build; a full 40-hex git SHA. */
  targetSha: string
  /** Harness home; the new payload lands in `home/desktop/payloads/<sha>`. */
  home: string
  /** Scratch directory, cleared at the start of the run. */
  workDir: string
  /** The running payload's Node executable, copied into the new payload. */
  currentNodeBinary: string
  /** npm registry for the pnpm tarball; defaults to registry.npmjs.org. */
  registryUrl?: string
  /** GitHub base for tarballs; defaults to https://github.com. */
  githubBase?: string
  /** Progress sink. */
  onProgress?: (progress: UpdateProgress) => void
  /** Log sink, forwarded subprocess output. */
  onLog?: (message: string) => void
}

/** The outcome of a successful update. */
export interface RunSourceUpdateResult {
  /** The new payload root (already smoke-tested and activated). */
  payloadRoot: string
  /** The activated upstream ref. */
  sourceRef: string
}

/** How many trailing output lines a failed subprocess keeps for diagnostics. */
const FAILED_COMMAND_TAIL_LINES = 40

/** Host PATH entries GUI launches often omit; native addon scripts need them. */
const HOST_PATH_PREFIX = '/usr/bin:/bin:/usr/local/bin'

/** Environment keys the update child may inherit from the parent process. */
const UPDATE_ENV_KEEP = [
  'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'PATH',
  'http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY',
] as const

/**
 * Build the subprocess environment for pnpm/tar running under Electron.
 *
 * The job must not inherit Electron's `NODE_OPTIONS` / `ELECTRON_*` (they
 * break the bundled Node), and must not use the user's global pnpm store —
 * that store is often root-owned after a `sudo pnpm`, which makes a normal
 * desktop session fail with EACCES and only `exit code 1` in the dialog.
 *
 * @param workDir - the update scratch directory; store and cache live under it.
 * @param source - the parent environment to copy proxy/PATH/HOME from.
 * @returns a closed env for every update subprocess.
 */
export function buildUpdateChildEnv(workDir: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    CI: 'true',
    GIT_TERMINAL_PROMPT: '0',
    PNPM_HOME: join(workDir, 'pnpm-home'),
    npm_config_store_dir: join(workDir, 'pnpm-store'),
    XDG_CACHE_HOME: join(workDir, 'cache'),
  }
  for (const key of UPDATE_ENV_KEEP) {
    const value = source[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  const path = env.PATH ?? HOST_PATH_PREFIX
  env.PATH = path.split(':').includes('/usr/bin') ? path : `${HOST_PATH_PREFIX}:${path}`
  return env
}

/** Extract the pnpm version from a packageManager field like `pnpm@11.7.0`. */
export function parsePnpmVersion(packageManager: string | undefined): string {
  if (packageManager !== undefined && packageManager.startsWith('pnpm@')) {
    const version = packageManager.slice('pnpm@'.length)
    if (/^\d+\.\d+\.\d+/.test(version)) return version
  }
  return DEFAULT_PNPM_VERSION
}

/** Run one subprocess, forwarding output lines; failures include the command and tail. */
async function run(
  label: string,
  command: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => void,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const printable = [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
  onLine(`${label}: ${printable}`)
  const tail: string[] = []
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env })
    const forward = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line === '') continue
        tail.push(line)
        if (tail.length > FAILED_COMMAND_TAIL_LINES) tail.shift()
        onLine(line)
      }
    }
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)
    child.once('error', (error) => { reject(new Error(`update: ${label} failed to spawn: ${error.message} (${printable})`)) })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      const reason = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
      const detail = tail.length > 0 ? `\n${tail.join('\n')}` : ''
      reject(new Error(`update: ${label} failed (${reason}): ${printable}${detail}`))
    })
  })
}

/** Per-attempt download timeout; large archives on slow links need headroom. */
const DOWNLOAD_TIMEOUT_MS = 300_000

/** Download retry count on network failures. */
const DOWNLOAD_RETRIES = 3

/**
 * Fetch one URL to a Buffer, following redirects manually and failing loud.
 *
 * The redirect is resolved by hand instead of relying on undici's automatic
 * following: on some networks the github.com → codeload redirect reuses a
 * keep-alive connection that the target resets, and the automatic follow then
 * fails while a direct request to the Location URL succeeds.
 * @param url - the download URL.
 * @param label - the human-readable download name for error messages.
 * @returns the response body.
 * @throws on HTTP or network failure, including after the retries.
 */
async function fetchBody(url: string, label: string): Promise<Buffer> {
  let lastError: unknown
  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (location === null) throw new Error(`update: ${label} redirect without Location (HTTP ${response.status}): ${url}`)
        return await fetchBody(new URL(location, url).toString(), label)
      }
      if (!response.ok) throw new Error(`update: failed to download ${label} (HTTP ${response.status}): ${url}`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      lastError = error
      if (attempt < DOWNLOAD_RETRIES) await new Promise(resolve => setTimeout(resolve, attempt * 1000))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`update: failed to download ${label}: ${String(lastError)}`)
}

/** Download a file to disk; fails loud with the URL in the message. */
async function download(url: string, destination: string, label: string): Promise<void> {
  await writeFile(destination, await fetchBody(url, label))
}

/** Extract a tar archive into a directory and return the single top-level dir. */
async function extractTarball(archive: string, extractDir: string, env: NodeJS.ProcessEnv): Promise<string> {
  await mkdir(extractDir, { recursive: true })
  await run('extract source', 'tar', ['-xf', archive, '-C', extractDir], extractDir, () => {}, env)
  const entries = await readdir(extractDir)
  if (entries.length !== 1) {
    throw new Error(`update: source archive did not extract to a single directory (found ${entries.length} entries)`)
  }
  return join(extractDir, entries[0] as string)
}

/**
 * Run the full source update pipeline.
 * @param options - repo, target SHA, home, and sinks.
 * @returns the activated payload root.
 * @throws on any step failure; the work directory is kept for inspection.
 */
export async function runSourceUpdate(options: RunSourceUpdateOptions): Promise<RunSourceUpdateResult> {
  const {
    repo, targetSha, home, workDir, currentNodeBinary,
    registryUrl = 'https://registry.npmjs.org', githubBase = 'https://github.com',
    onProgress, onLog,
  } = options
  const log = onLog ?? ((message: string) => { console.log(message) })
  const progress = (stage: UpdateStage, detail: string): void => { onProgress?.({ stage, detail }) }
  if (!/^[0-9a-f]{40}$/.test(targetSha)) {
    throw new Error(`update: invalid target ref ${JSON.stringify(targetSha)}; expected a 40-hex git SHA`)
  }

  await rm(workDir, { recursive: true, force: true })
  await mkdir(workDir, { recursive: true })
  const env = buildUpdateChildEnv(workDir)
  try {
    progress('download-source', `下载 ${repo}@${targetSha.slice(0, 12)} 源码`)
    const archivePath = join(workDir, 'source.tar.gz')
    await download(`${githubBase}/${repo}/archive/${targetSha}.tar.gz`, archivePath, 'source archive')

    progress('extract', '解压源码')
    const srcRoot = await extractTarball(archivePath, join(workDir, 'extract'), env)

    const manifest = JSON.parse(readFileSync(join(srcRoot, 'package.json'), 'utf8')) as { packageManager?: unknown }
    const pnpmVersion = parsePnpmVersion(typeof manifest.packageManager === 'string' ? manifest.packageManager : undefined)

    progress('install', `准备 pnpm@${pnpmVersion} 并安装依赖（首次较慢）`)
    const pnpmArchive = join(workDir, 'pnpm.tgz')
    await download(`${registryUrl}/pnpm/-/pnpm-${pnpmVersion}.tgz`, pnpmArchive, 'pnpm')
    const pnpmExtractDir = join(workDir, 'pnpm-extract')
    await mkdir(pnpmExtractDir, { recursive: true })
    await run('extract pnpm', 'tar', ['-xf', pnpmArchive, '-C', pnpmExtractDir], workDir, log, env)
    const pnpmCjs = join(pnpmExtractDir, 'package', 'bin', 'pnpm.cjs')
    if (!existsSync(pnpmCjs)) throw new Error(`update: pnpm.cjs missing at ${pnpmCjs}`)
    try {
      await run('install dependencies', currentNodeBinary, [pnpmCjs, 'install', '--frozen-lockfile'], srcRoot, log, env)
    } catch (error) {
      log(`update: frozen install failed (${error instanceof Error ? error.message : String(error)}); retrying without frozen lockfile`)
      await run('install dependencies', currentNodeBinary, [pnpmCjs, 'install'], srcRoot, log, env)
    }

    progress('build', '构建 lib 与 web 产物')
    await run('build', currentNodeBinary, [pnpmCjs, 'run', 'build'], srcRoot, log, env)

    progress('assemble', '组装新载荷并通过启动冒烟')
    await assemblePayload({
      sourceRoot: srcRoot,
      outDir: join(payloadsDir(home), targetSha),
      stageDir: join(workDir, 'stage'),
      pnpmArgs: [currentNodeBinary, pnpmCjs],
      sourceRef: targetSha,
      nodeBinarySource: currentNodeBinary,
      env,
      onLog: log,
    })

    progress('finalize', '切换为新版本')
    await mkdir(payloadsDir(home), { recursive: true })
    switchCurrentPointer(home, targetSha)

    await rm(workDir, { recursive: true, force: true })
    const payloadRoot = join(payloadsDir(home), targetSha)
    log(`update: activated ${repo}@${targetSha.slice(0, 12)} at ${payloadRoot}`)
    return { payloadRoot, sourceRef: targetSha }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}\nupdate: build tree kept at ${workDir} for inspection`)
  }
}

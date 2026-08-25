/**
 * Assemble one self-contained backend payload from a repository checkout.
 *
 * A payload carries the bundled Node runtime, the hoisted production
 * dependency closure from `apps/desktop/deploy-root` (which includes the dsh
 * CLI itself, so its lib/ and shipped agent-presets travel inside
 * `runtime/node_modules/@deepseek-ai/dsh`), and the built frontend dist
 * (shipped inside the deployed `dsh-web-frontend`). It ends with a keyless
 * boot smoke that runs the staged CLI over a scratch `$DSH_HOME` and asserts
 * the served index carries the `__DSH_BOOT__` boot manifest — the same
 * readiness signal the desktop window waits for. The smoke is the update
 * gate: a payload that cannot boot is never activated.
 *
 * The closure lives under `runtime/node_modules` rather than the payload
 * root: electron-builder's extraResources copy hard-excludes a source root's
 * own `node_modules` directory, while nested ones pass through.
 *
 * Two consumers share this module: the build-time script
 * (`scripts/assemble-payload.ts`, system pnpm via `pnpm dlx`, Node runtime
 * downloaded from nodejs.org) and the in-app source updater (bootstrapped
 * pnpm running on the bundled Node, reusing the running payload's Node
 * executable).
 *
 * Deployment flags mirror `scripts/build-exe-for-python-sdk.ts`: the legacy
 * hoisted linker is required because the profile module fallback
 * (`healProfilesModuleFallback`) resolves bare plugin rows through the flat
 * installation `node_modules`, and `--prod` drops workspace peers that are
 * also devDependencies — the deploy root lists every peer explicitly and
 * `verify-runtime-closure` enforces it.
 * @module @deepseek-ai/dsh-desktop/payload-builder
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, cp, lstat, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { launchServer, DEFAULT_READY_TIMEOUT_MS } from './server-launcher.ts'
import { indexCarriesBootManifest } from './boot-manifest.ts'
import { PAYLOAD_FORMAT } from './payload.ts'

/** The dependency-only manifest whose closure is the payload. */
const DEPLOY_ROOT_PACKAGE = 'dsh-desktop-web-runtime-pkg'
/** Pinned Node runtime for download-path builds; must satisfy the repo engines (^22.19 || >=24). */
const NODE_VERSION = 'v22.23.2'
/** Docs shipped by pnpm deploy that the payload does not need. */
const DEPLOY_ONLY_DOCS = ['README.md', 'README.zh.md', 'README.i18n.yaml']

/** Options for {@link assemblePayload}. */
export interface AssemblePayloadOptions {
  /** The repository root whose built artifacts become the payload. */
  sourceRoot: string
  /** The payload output directory (created, and cleared if it exists). */
  outDir: string
  /** Scratch directory for downloads, extraction, and the smoke home. */
  stageDir: string
  /**
   * The full pnpm invocation prefix as `[command, ...args]`: the build
   * script passes `['pnpm', 'dlx', 'pnpm@<version>']`, the updater passes
   * `[<bundled node>, <pnpm.cjs>]` (the bundled Node is not on PATH). The
   * closure deploy and the workspace restore run through it.
   */
  pnpmArgs: readonly string[]
  /** Upstream ref recorded in the manifest; the update check compares it. */
  sourceRef?: string
  /**
   * Copy this existing Node executable into the payload instead of
   * downloading one — the in-app updater reuses the running payload's Node.
   */
  nodeBinarySource?: string
  /**
   * Subprocess environment for pnpm and the rest of the assemble steps.
   * The in-app updater passes a closed env with an isolated pnpm store;
   * omitted, the process environment plus `CI=true` (the build-time path).
   */
  env?: NodeJS.ProcessEnv
  /** Log sink; defaults to `console.log`. */
  onLog?: (message: string) => void
}

interface NodeDistTarget {
  fileName: string
  nodeBinary: string
}

/** Resolve the Node dist target for the current platform, or fail loud. */
function nodeDistTarget(): NodeDistTarget {
  if (process.platform === 'linux' && process.arch === 'x64') {
    return { fileName: `node-${NODE_VERSION}-linux-x64.tar.xz`, nodeBinary: 'node/bin/node' }
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    return { fileName: `node-${NODE_VERSION}-linux-arm64.tar.xz`, nodeBinary: 'node/bin/node' }
  }
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return { fileName: `node-${NODE_VERSION}-darwin-x64.tar.gz`, nodeBinary: 'node/bin/node' }
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return { fileName: `node-${NODE_VERSION}-darwin-arm64.tar.gz`, nodeBinary: 'node/bin/node' }
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return { fileName: `node-${NODE_VERSION}-win-x64.zip`, nodeBinary: 'node/node.exe' }
  }
  throw new Error(`assemble-payload: unsupported target ${process.platform}-${process.arch}`)
}

/** Module-level log sink, set per {@link assemblePayload} call. */
let log: (message: string) => void = console.log
/** Subprocess env, set per {@link assemblePayload} call. */
let childEnv: NodeJS.ProcessEnv = { ...process.env, CI: 'true' }

/** Run one subprocess, forwarding its output lines; failures include the command. */
async function run(label: string, command: string, args: string[], cwd: string): Promise<void> {
  const printable = [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
  log(`${label}: ${printable}`)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv })
    const forward = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line !== '') log(line)
      }
    }
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)
    child.once('error', (error) => { reject(new Error(`assemble-payload: ${label} failed to spawn: ${error.message} (${printable})`)) })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`assemble-payload: ${label} failed (${code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`}): ${printable}`))
    })
  })
}

/** Verify the built artifacts the payload needs exist. */
function verifyBuiltArtifacts(sourceRoot: string): void {
  const cliEntry = join(sourceRoot, 'apps/cli/lib/bin.js')
  const distIndex = join(sourceRoot, 'apps/web/dist/index.html')
  if (!existsSync(cliEntry) || !existsSync(distIndex)) {
    throw new Error(
      'assemble-payload: built artifacts missing; run `pnpm run build` in the source checkout first '
      + `(checked ${cliEntry} and ${distIndex})`,
    )
  }
}

/**
 * Restore direct packages that pnpm's legacy hoister places beside the deploy
 * source instead of in the target. The deploy root supplies every peer, so
 * package-local node_modules trees are omitted to preserve one flat closure.
 */
async function restoreLegacyHoists(sourceRoot: string, payload: string): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(payload, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  const sourceNodeModules = join(sourceRoot, 'apps/desktop/deploy-root/node_modules')
  const restored: string[] = []
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(payload, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(sourceNodeModules, dependency)
    if (!existsSync(source)) {
      throw new Error(`assemble-payload: deployed dependency ${dependency} is absent from both ${destination} and ${source}`)
    }
    await mkdir(dirname(destination), { recursive: true })
    const nestedNodeModules = join(source, 'node_modules')
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    restored.push(dependency)
  }
  const stillMissing = Object.keys(manifest.dependencies ?? {})
    .filter(dependency => !existsSync(join(payload, 'node_modules', dependency)))
  if (stillMissing.length > 0) {
    throw new Error(`assemble-payload: staged dependencies remain missing: ${stillMissing.join(', ')}`)
  }
  if (restored.length > 0) log(`assemble-payload: restored legacy deploy hoists: ${restored.join(', ')}`)
}

/** Replace deploy-time package links with real copies and reject any remaining link. */
async function materializeStagedLinks(payload: string): Promise<void> {
  const nodeModules = join(payload, 'node_modules')
  let remaining = await findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
      remaining = await findSymlink(nodeModules)
      continue
    }
    const destination = remaining
    const source = await realpath(destination)
    const nestedNodeModules = join(source, 'node_modules')
    await rm(destination, { recursive: true, force: true })
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    remaining = await findSymlink(nodeModules)
  }
}

/** Return the first symbolic link below a directory, if one exists. */
async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Download the pinned Node runtime archive and verify its SHA256. */
async function downloadNodeRuntime(target: NodeDistTarget, destinationDir: string): Promise<string> {
  const baseUrl = `https://nodejs.org/dist/${NODE_VERSION}`
  const checksums = await fetch(`${baseUrl}/SHASUMS256.txt`).then(async (response) => {
    if (!response.ok) throw new Error(`assemble-payload: failed to fetch SHASUMS256.txt (HTTP ${response.status})`)
    return await response.text()
  })
  const expected = checksums.split('\n')
    .map(line => line.trim())
    .find(line => line.endsWith(`  ${target.fileName}`) || line.endsWith(` *${target.fileName}`))
    ?.split(/\s+/)[0]
  if (expected === undefined) {
    throw new Error(`assemble-payload: ${target.fileName} missing from ${baseUrl}/SHASUMS256.txt`)
  }
  const archivePath = join(destinationDir, target.fileName)
  const response = await fetch(`${baseUrl}/${target.fileName}`)
  if (!response.ok) throw new Error(`assemble-payload: failed to download Node runtime (HTTP ${response.status})`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) {
    throw new Error(`assemble-payload: Node runtime checksum mismatch for ${target.fileName} (expected ${expected}, got ${actual})`)
  }
  await writeFile(archivePath, bytes)
  return archivePath
}

/** Extract just the Node executable from a dist archive into the payload's node/ directory. */
async function extractNodeRuntime(archivePath: string, nodeDir: string): Promise<void> {
  await mkdir(nodeDir, { recursive: true })
  const extractDir = join(dirname(archivePath), 'extract')
  await rm(extractDir, { recursive: true, force: true })
  await mkdir(extractDir, { recursive: true })
  // tar handles .tar.xz/.tar.gz everywhere and zip on Windows 10 1803+ (bsdtar).
  await run('extract node runtime', 'tar', ['-xf', archivePath, '-C', extractDir], dirname(archivePath))
  const entries = await readdir(extractDir)
  const inner = entries.length === 1 ? join(extractDir, entries[0] as string) : extractDir
  // The official binaries are self-contained (full ICU is compiled in); npm,
  // headers, and share/ docs are not needed by the backend.
  const executable = process.platform === 'win32' ? join(inner, 'node.exe') : join(inner, 'bin', 'node')
  if (!existsSync(executable)) {
    throw new Error(`assemble-payload: no node executable found at ${executable} in ${archivePath}`)
  }
  const target = process.platform === 'win32' ? join(nodeDir, 'node.exe') : join(nodeDir, 'bin', 'node')
  await mkdir(dirname(target), { recursive: true })
  await cp(executable, target)
  await rm(extractDir, { recursive: true, force: true })
}

/** Boot the staged CLI over a scratch home and assert the GUI serves. */
async function runSmoke(payload: string, smokeHome: string): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(payload, 'payload.json'), 'utf8')) as { cliEntry: string; nodeBinary: string }
  log('assemble-payload: smoke-booting the staged backend over a scratch DSH_HOME')
  const server = launchServer({
    nodeBinary: join(payload, manifest.nodeBinary),
    cliEntry: join(payload, manifest.cliEntry),
    env: { DSH_HOME: smokeHome },
    readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
    onLine: (line) => { log(`  [smoke dsh web] ${line}`) },
  })
  try {
    const url = await server.url
    const response = await fetch(`${url}/`)
    if (!response.ok) throw new Error(`assemble-payload: smoke index returned HTTP ${response.status}`)
    const html = await response.text()
    if (!indexCarriesBootManifest(html)) {
      throw new Error('assemble-payload: smoke index does not carry the __DSH_BOOT__ boot manifest; the GUI cannot boot')
    }
    log(`assemble-payload: smoke passed — ${url} serves the boot manifest`)
  } finally {
    await server.stop()
  }
}

/** Recursively compute a directory's total size in bytes. */
export async function dirSize(directory: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) total += await dirSize(path)
    else total += (await stat(path)).size
  }
  return total
}

/**
 * Assemble a payload from a built checkout into `outDir`. The last step is
 * the boot smoke: a payload that does not serve the GUI manifest fails the
 * whole build, so a caller can activate the output without re-verifying.
 * @param options - source checkout, output, pnpm invocation, and Node source.
 * @throws on any step failure; the output directory is left for inspection.
 */
export async function assemblePayload(options: AssemblePayloadOptions): Promise<void> {
  const { sourceRoot, outDir, stageDir, pnpmArgs, sourceRef, nodeBinarySource } = options
  log = options.onLog ?? console.log
  childEnv = options.env ?? { ...process.env, CI: 'true' }
  verifyBuiltArtifacts(sourceRoot)
  if (!existsSync(join(sourceRoot, 'apps/desktop/deploy-root/package.json'))) {
    throw new Error(
      'assemble-payload: the source checkout has no apps/desktop/deploy-root/package.json; '
      + 'call ensureDesktopDeployRoot(sourceRoot) before assemblePayload when building upstream without apps/desktop',
    )
  }
  await run('verify runtime closure', pnpmArgs[0] ?? 'pnpm', [
    ...pnpmArgs.slice(1),
    'exec', 'tsx', 'scripts/verify-runtime-closure.ts', '--manifest', 'apps/desktop/deploy-root/package.json',
  ], sourceRoot)
  await rm(outDir, { recursive: true, force: true })
  await rm(stageDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  await mkdir(stageDir, { recursive: true })

  const runtimeDir = join(outDir, 'runtime')
  await run('deploy closure', pnpmArgs[0] ?? 'pnpm', [
    ...pnpmArgs.slice(1),
    '--filter', DEPLOY_ROOT_PACKAGE,
    'deploy', '--legacy', '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    runtimeDir,
  ], sourceRoot)
  // pnpm's legacy deploy re-resolves the workspace and prunes package-level
  // devDependency links from the source install; restore them so the checkout
  // stays healthy after a payload build. Not frozen: the deploy-root manifest
  // may have changed since the committed lockfile.
  await run('restore workspace install', pnpmArgs[0] ?? 'pnpm', [
    ...pnpmArgs.slice(1),
    'install', '--no-frozen-lockfile',
  ], sourceRoot)
  await restoreLegacyHoists(sourceRoot, runtimeDir)
  await materializeStagedLinks(runtimeDir)
  for (const name of DEPLOY_ONLY_DOCS) await rm(join(runtimeDir, name), { force: true })

  const target = nodeDistTarget()
  if (nodeBinarySource !== undefined) {
    const destination = join(outDir, target.nodeBinary)
    await mkdir(dirname(destination), { recursive: true })
    await cp(nodeBinarySource, destination)
    if (process.platform !== 'win32') await chmod(destination, 0o755)
  } else {
    const archivePath = await downloadNodeRuntime(target, stageDir)
    await extractNodeRuntime(archivePath, join(outDir, 'node'))
    const nodeBinaryPath = join(outDir, target.nodeBinary)
    if (process.platform !== 'win32') await chmod(nodeBinaryPath, 0o755)
  }

  const manifest: Record<string, string | number> = {
    format: PAYLOAD_FORMAT,
    cliEntry: 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
    nodeBinary: target.nodeBinary,
  }
  if (sourceRef !== undefined) manifest.sourceRef = sourceRef
  await writeFile(join(outDir, 'payload.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  await runSmoke(outDir, join(stageDir, 'smoke-home'))
  log(`assemble-payload: payload ready at ${outDir}`)
}

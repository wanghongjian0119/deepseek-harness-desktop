/**
 * Ensure a desktop deploy-root exists in a repository checkout.
 *
 * Official upstream (`deepseek-ai/deepseek-harness`) has no `apps/desktop` —
 * only this fork ships the Electron packaging. An in-app update still builds
 * official master, then materializes `apps/desktop/deploy-root` from the
 * fetched workspace graph so {@link assemblePayload} can `pnpm deploy` the
 * backend closure.
 * @module @deepseek-ai/dsh-desktop/ensure-deploy-root
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface PackageManifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

/** Relative path of the deploy-root package inside a checkout. */
export const DEPLOY_ROOT_RELATIVE = 'apps/desktop/deploy-root'

/** npm name of the deploy-root workspace package. */
export const DEPLOY_ROOT_PACKAGE_NAME = 'dsh-desktop-web-runtime-pkg'

const APP_PACKAGE = '@deepseek-ai/dsh'

/** Load every workspace member manifest under a checkout. */
function loadWorkspace(sourceRoot: string): Map<string, PackageManifest> {
  const paths = globSync(
    ['packages/*/*/package.json', 'vendor/*/package.json', 'apps/*/package.json'],
    { cwd: sourceRoot },
  )
  const workspace = new Map<string, PackageManifest>()
  for (const relative of paths) {
    const manifest = JSON.parse(readFileSync(join(sourceRoot, relative), 'utf8')) as PackageManifest
    if (manifest.name !== undefined) workspace.set(manifest.name, manifest)
  }
  return workspace
}

/** BFS the workspace closure from one package's dependencies. */
function closureFrom(app: PackageManifest, workspace: Map<string, PackageManifest>): string[] {
  const deps: string[] = []
  const queue = [...Object.keys(app.dependencies ?? {})]
  while (queue.length > 0) {
    const name = queue.shift() as string
    if (deps.includes(name)) continue
    const manifest = workspace.get(name)
    if (manifest === undefined) continue
    deps.push(name)
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    })) {
      if (workspace.has(dependency) && !deps.includes(dependency)) queue.push(dependency)
    }
  }
  return deps.sort()
}

/**
 * Build the deploy-root package.json contents for a checkout.
 * @param sourceRoot - repository root that already contains built packages.
 * @returns the manifest object to write.
 */
export function buildDeployRootManifest(sourceRoot: string): {
  name: string
  description: string
  version: string
  private: true
  type: 'module'
  dependencies: Record<string, string>
} {
  const workspace = loadWorkspace(sourceRoot)
  const app = workspace.get(APP_PACKAGE)
  if (app === undefined) {
    throw new Error(`ensure-deploy-root: ${APP_PACKAGE} is not a workspace member under ${sourceRoot}`)
  }
  const version = typeof app.version === 'string' && app.version !== '' ? app.version : '0.0.0'
  const dependencies: Record<string, string> = { [APP_PACKAGE]: 'workspace:^' }
  for (const name of closureFrom(app, workspace)) dependencies[name] = 'workspace:^'
  return {
    name: DEPLOY_ROOT_PACKAGE_NAME,
    description:
      'Dependency-only deploy root defining the desktop backend closure; generated at update time when upstream lacks apps/desktop.',
    version,
    private: true,
    type: 'module',
    dependencies,
  }
}

/**
 * Materialize `apps/desktop/deploy-root` and register it in the workspace.
 * @param sourceRoot - built repository checkout.
 * @returns whether a deploy-root was created (false if it already existed).
 */
export async function ensureDesktopDeployRoot(sourceRoot: string): Promise<boolean> {
  const deployRoot = join(sourceRoot, DEPLOY_ROOT_RELATIVE)
  const manifestPath = join(deployRoot, 'package.json')
  if (existsSync(manifestPath)) return false

  const manifest = buildDeployRootManifest(sourceRoot)
  await mkdir(deployRoot, { recursive: true })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const workspacePath = join(sourceRoot, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) {
    throw new Error(`ensure-deploy-root: missing pnpm-workspace.yaml under ${sourceRoot}`)
  }
  const text = readFileSync(workspacePath, 'utf8')
  if (!text.includes('apps/desktop/deploy-root')) {
    const marker = '  - apps/*\n'
    const rewritten = text.includes(marker)
      ? text.replace(marker, `${marker}  - apps/desktop/deploy-root\n`)
      : `${text.endsWith('\n') ? text : `${text}\n`}  - apps/desktop/deploy-root\n`
    await writeFile(workspacePath, rewritten)
  }
  return true
}

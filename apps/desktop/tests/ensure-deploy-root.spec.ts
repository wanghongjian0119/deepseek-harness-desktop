import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDeployRootManifest, ensureDesktopDeployRoot } from '../src/ensure-deploy-root.ts'

const scratchRoots: string[] = []

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** Minimal workspace that looks enough like a harness checkout for deploy-root generation. */
function writeMinimalCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-deploy-root-'))
  scratchRoots.push(root)
  mkdirSync(join(root, 'packages/core/dsh'), { recursive: true })
  mkdirSync(join(root, 'packages/util/brand'), { recursive: true })
  mkdirSync(join(root, 'apps/cli'), { recursive: true })
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*/*\n  - apps/*\n')
  writeFileSync(join(root, 'packages/util/brand/package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-brand',
    version: '1.2.3',
    dependencies: {},
  }))
  writeFileSync(join(root, 'packages/core/dsh/package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: '1.2.3',
    dependencies: { '@deepseek-ai/dsh-brand': 'workspace:^' },
  }))
  writeFileSync(join(root, 'apps/cli/package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-cli',
    version: '1.2.3',
  }))
  return root
}

describe('buildDeployRootManifest', () => {
  it('includes the CLI closure from @deepseek-ai/dsh', () => {
    const root = writeMinimalCheckout()
    const manifest = buildDeployRootManifest(root)
    expect(manifest.name).toBe('dsh-desktop-web-runtime-pkg')
    expect(manifest.version).toBe('1.2.3')
    expect(manifest.dependencies['@deepseek-ai/dsh']).toBe('workspace:^')
    expect(manifest.dependencies['@deepseek-ai/dsh-brand']).toBe('workspace:^')
  })
})

describe('ensureDesktopDeployRoot', () => {
  it('writes deploy-root and registers it in the workspace file', async () => {
    const root = writeMinimalCheckout()
    expect(await ensureDesktopDeployRoot(root)).toBe(true)
    expect(existsSync(join(root, 'apps/desktop/deploy-root/package.json'))).toBe(true)
    expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')).toContain('apps/desktop/deploy-root')
    expect(await ensureDesktopDeployRoot(root)).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { accessSync, constants, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_PNPM_VERSION,
  buildUpdateChildEnv,
  ensurePackageManagerShims,
  formatByteSize,
  parsePnpmVersion,
  pnpmRegistryArgs,
  prependPathEntry,
  rewriteLockfileNpmjsHosts,
  writeCheckoutNpmrc,
} from '../src/updater/update-job.ts'

describe('parsePnpmVersion', () => {
  it('extracts the version from a packageManager field', () => {
    expect(parsePnpmVersion('pnpm@11.7.0')).toBe('11.7.0')
    expect(parsePnpmVersion('pnpm@9.15.9')).toBe('9.15.9')
  })

  it('falls back to the default for missing or foreign values', () => {
    expect(parsePnpmVersion(undefined)).toBe(DEFAULT_PNPM_VERSION)
    expect(parsePnpmVersion('yarn@4.0.0')).toBe(DEFAULT_PNPM_VERSION)
    expect(parsePnpmVersion('')).toBe(DEFAULT_PNPM_VERSION)
  })
})

describe('buildUpdateChildEnv', () => {
  it('isolates the pnpm store under the work directory and drops Electron node options', () => {
    const env = buildUpdateChildEnv('/tmp/update-work', {
      HOME: '/home/user',
      PATH: '/usr/bin:/bin',
      NODE_OPTIONS: '--require /opt/app.asar',
      ELECTRON_RUN_AS_NODE: '1',
      https_proxy: 'http://127.0.0.1:7890',
    })
    expect(env.npm_config_store_dir).toBe('/tmp/update-work/pnpm-store')
    expect(env.PNPM_HOME).toBe('/tmp/update-work/pnpm-home')
    expect(env.CI).toBe('true')
    expect(env.HOME).toBe('/home/user')
    expect(env.https_proxy).toBe('http://127.0.0.1:7890')
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('prepends host binaries when PATH has none', () => {
    const env = buildUpdateChildEnv('/tmp/w', { PATH: '/opt/custom/bin' })
    expect(env.PATH?.startsWith('/usr/bin:/bin:/usr/local/bin:')).toBe(true)
  })

  it('prepends the bundled Node directory so lifecycle scripts find node', () => {
    const env = buildUpdateChildEnv('/tmp/w', { PATH: '/usr/bin:/bin' }, '/opt/DeepSeek Harness/resources/dsh/node/bin/node')
    expect(env.PATH?.startsWith('/opt/DeepSeek Harness/resources/dsh/node/bin:')).toBe(true)
  })

  it('sets npm_config_registry when a mirror URL is provided', () => {
    const env = buildUpdateChildEnv('/tmp/w', {
      PATH: '/usr/bin',
      npm_config_registry: 'https://registry.npmjs.org',
    }, undefined, 'https://registry.npmmirror.com')
    expect(env.npm_config_registry).toBe('https://registry.npmmirror.com')
  })

  it('uses an explicit storeDir outside the work directory when provided', () => {
    const env = buildUpdateChildEnv(
      '/tmp/update-work',
      { PATH: '/usr/bin' },
      undefined,
      undefined,
      '/home/user/.dsh/desktop/pnpm-store',
    )
    expect(env.npm_config_store_dir).toBe('/home/user/.dsh/desktop/pnpm-store')
    expect(env.PNPM_HOME).toBe('/tmp/update-work/pnpm-home')
  })
})

describe('ensurePackageManagerShims / prependPathEntry', () => {
  it('writes executable npm/npx/pnpm shims that exec node + pnpm.cjs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-npm-shim-'))
    try {
      const binDir = join(root, 'bin')
      const node = '/opt/DeepSeek Harness/resources/dsh/node/bin/node'
      const pnpmCjs = join(root, 'pnpm.cjs')
      writeFileSync(pnpmCjs, 'console.log("pnpm")\n')
      await ensurePackageManagerShims(binDir, node, pnpmCjs)
      for (const name of ['npm', 'npx', 'pnpm']) {
        const path = join(binDir, name)
        accessSync(path, constants.X_OK)
        const body = readFileSync(path, 'utf8')
        expect(body.startsWith('#!/bin/sh\n')).toBe(true)
        expect(body).toContain(`exec ${JSON.stringify(node)} ${JSON.stringify(pnpmCjs)}`)
        expect(body).toContain('"$@"')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('prepends the shim bin directory to PATH', () => {
    const env = { PATH: '/usr/bin:/bin' }
    prependPathEntry(env, '/tmp/update-work/bin')
    expect(env.PATH).toBe('/tmp/update-work/bin:/usr/bin:/bin')
    prependPathEntry(env, '/tmp/update-work/bin')
    expect(env.PATH).toBe('/tmp/update-work/bin:/usr/bin:/bin')
  })
})

describe('formatByteSize', () => {
  it('formats byte sizes for download logs', () => {
    expect(formatByteSize(512)).toBe('512 B')
    expect(formatByteSize(2048)).toBe('2.0 KB')
    expect(formatByteSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})

describe('pnpmRegistryArgs', () => {
  it('returns an explicit --registry flag pair', () => {
    expect(pnpmRegistryArgs('https://registry.npmmirror.com')).toEqual([
      '--registry',
      'https://registry.npmmirror.com',
    ])
  })
})

describe('writeCheckoutNpmrc / rewriteLockfileNpmjsHosts', () => {
  it('writes .npmrc and rewrites lockfile npmjs hosts to the mirror', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-npmrc-'))
    try {
      writeFileSync(join(root, 'pnpm-lock.yaml'), [
        'packages:',
        '  foo:',
        '    resolution: {tarball: https://registry.npmjs.org/foo/-/foo-1.0.0.tgz}',
        '  bar:',
        '    resolution: {tarball: https://registry.npmjs.org/bar/-/bar-2.0.0.tgz}',
        '',
      ].join('\n'))
      await writeCheckoutNpmrc(root, 'https://registry.npmmirror.com')
      expect(readFileSync(join(root, '.npmrc'), 'utf8')).toBe('registry=https://registry.npmmirror.com\n')
      expect(await rewriteLockfileNpmjsHosts(root, 'https://registry.npmmirror.com')).toBe(2)
      expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toContain('registry.npmmirror.com')
      expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).not.toContain('registry.npmjs.org')
      expect(await rewriteLockfileNpmjsHosts(root, 'https://registry.npmjs.org')).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

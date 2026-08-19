import { describe, expect, it } from 'vitest'
import { DEFAULT_PNPM_VERSION, buildUpdateChildEnv, parsePnpmVersion } from '../src/updater/update-job.ts'

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
})

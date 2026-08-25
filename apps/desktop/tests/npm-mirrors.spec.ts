import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NPM_MIRROR_ID,
  NPM_MIRRORS,
  resolveNpmRegistry,
} from '../src/updater/npm-mirrors.ts'

describe('resolveNpmRegistry', () => {
  it('defaults to the first built-in mirror', () => {
    expect(resolveNpmRegistry(undefined)).toBe(
      NPM_MIRRORS.find(m => m.id === DEFAULT_NPM_MIRROR_ID)?.url,
    )
  })

  it('resolves known mirror ids', () => {
    expect(resolveNpmRegistry('official')).toBe('https://registry.npmjs.org')
    expect(resolveNpmRegistry('npmmirror')).toBe('https://registry.npmmirror.com')
  })

  it('accepts a raw https registry URL', () => {
    expect(resolveNpmRegistry('https://example.com/npm/')).toBe('https://example.com/npm')
  })
})

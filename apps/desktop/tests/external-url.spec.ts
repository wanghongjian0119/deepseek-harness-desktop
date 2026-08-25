import { describe, expect, it } from 'vitest'
import { shouldOpenExternally } from '../src/external-url.ts'

describe('shouldOpenExternally', () => {
  const origin = 'http://127.0.0.1:38763'

  it('allows a public https URL', () => {
    expect(shouldOpenExternally('https://example.com/docs', origin)).toBe(true)
  })

  it('denies loopback http URLs even when not the app origin', () => {
    expect(shouldOpenExternally('http://127.0.0.1:9999/', origin)).toBe(false)
    expect(shouldOpenExternally('http://localhost:9999/', origin)).toBe(false)
  })

  it('denies URLs under the app origin', () => {
    expect(shouldOpenExternally(`${origin}/chat`, origin)).toBe(false)
  })

  it('denies non-http(s) schemes', () => {
    expect(shouldOpenExternally('file:///tmp/x', origin)).toBe(false)
    expect(shouldOpenExternally('not a url', origin)).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { indexCarriesBootManifest } from '../src/boot-manifest.ts'

describe('indexCarriesBootManifest', () => {
  it('accepts the legacy window.__DSH_BOOT__ injection', () => {
    const html = '<head><script>window.__DSH_BOOT__ = {"rev":"a","entries":[]}</script></head>'
    expect(indexCarriesBootManifest(html)).toBe(true)
  })

  it('accepts the upstream globalThis["__DSH_BOOT__"] injection', () => {
    const html = '<head><script>globalThis["__DSH_BOOT__"] = {"rev":"a","entries":[]}</script></head>'
    expect(indexCarriesBootManifest(html)).toBe(true)
  })

  it('accepts globalThis with single-quoted key', () => {
    const html = "<script>globalThis['__DSH_BOOT__'] = {}</script>"
    expect(indexCarriesBootManifest(html)).toBe(true)
  })

  it('rejects a bare static Vite index with no host injection', () => {
    const html = `<!doctype html>
<html lang="en">
  <head>
    <title>DSH Local Build</title>
    <script type="module" crossorigin src="/assets/index.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>`
    expect(indexCarriesBootManifest(html)).toBe(false)
  })
})

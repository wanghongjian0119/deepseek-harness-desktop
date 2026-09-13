import { describe, expect, it } from 'vitest'
import { parseUrlLine } from '../src/url-line.ts'

describe('parseUrlLine', () => {
  it('extracts the loopback URL from the readiness line', () => {
    expect(parseUrlLine('dsh web: http://127.0.0.1:38271')).toBe('http://127.0.0.1:38271')
  })

  it('tolerates the LAN suffix printed after the loopback URL', () => {
    expect(parseUrlLine('dsh web: http://127.0.0.1:3080 (LAN: http://192.168.1.5:3080)')).toBe('http://127.0.0.1:3080')
  })

  it('keeps the boot token query so the smoke handshake and window can authenticate', () => {
    expect(parseUrlLine('dsh web: http://127.0.0.1:35151/?token=htOQaa43rVlOJt7D0UuYW7Vgl-uEAQwFRyVvQXFZutI'))
      .toBe('http://127.0.0.1:35151/?token=htOQaa43rVlOJt7D0UuYW7Vgl-uEAQwFRyVvQXFZutI')
  })

  it('keeps the token query even when a LAN suffix follows', () => {
    expect(parseUrlLine('dsh web: http://127.0.0.1:35151/?token=abc (LAN: http://192.168.1.5:35151/?token=abc)'))
      .toBe('http://127.0.0.1:35151/?token=abc')
  })

  it('returns undefined for unrelated lines', () => {
    expect(parseUrlLine('')).toBeUndefined()
    expect(parseUrlLine('dsh web: starting')).toBeUndefined()
    expect(parseUrlLine('something else entirely')).toBeUndefined()
  })
})

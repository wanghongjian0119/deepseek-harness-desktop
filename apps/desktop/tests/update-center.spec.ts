import { describe, expect, it } from 'vitest'
import { initialUpdateCenterState, shortRef } from '../src/updater/update-center.ts'

describe('shortRef', () => {
  it('shortens a full SHA and passes short values through', () => {
    expect(shortRef('a'.repeat(40))).toBe('a'.repeat(12))
    expect(shortRef('abc123')).toBe('abc123')
    expect(shortRef(undefined)).toBeUndefined()
    expect(shortRef('')).toBeUndefined()
  })
})

describe('initialUpdateCenterState', () => {
  it('warns when the payload has no source ref', () => {
    const state = initialUpdateCenterState(undefined)
    expect(state.available).toBe(false)
    expect(state.messageKind).toBe('warn')
    expect(state.phase).toBe('idle')
  })

  it('prompts a check when a source ref is present', () => {
    const sha = 'b'.repeat(40)
    const state = initialUpdateCenterState(sha)
    expect(state.currentSha).toBe(sha)
    expect(state.messageKind).toBe('busy')
    expect(state.busy).toBe(false)
    expect(state.mirrors.length).toBeGreaterThan(0)
    expect(state.registryId).toBeTruthy()
  })
})

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  offeredUpdatePath,
  readOfferedUpdateSha,
  writeOfferedUpdateSha,
} from '../src/updater/offered-update.ts'

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-desktop-offered-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('offered-update persistence', () => {
  it('returns undefined when the record is missing', () => {
    expect(readOfferedUpdateSha(home)).toBeUndefined()
  })

  it('round-trips a valid SHA', () => {
    writeOfferedUpdateSha(SHA_A, home)
    expect(readOfferedUpdateSha(home)).toBe(SHA_A)
  })

  it('overwrites the previous offered SHA', async () => {
    writeOfferedUpdateSha(SHA_A, home)
    writeOfferedUpdateSha(SHA_B, home)
    expect(readOfferedUpdateSha(home)).toBe(SHA_B)
    const raw = await readFile(offeredUpdatePath(home), 'utf8')
    expect(JSON.parse(raw)).toEqual({ offeredSha: SHA_B })
  })

  it('rejects a non-SHA string on write', () => {
    expect(() => writeOfferedUpdateSha('not-a-sha', home)).toThrow(/invalid sha/)
  })

  it('ignores a malformed on-disk record', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(home, 'desktop'), { recursive: true })
    await writeFile(offeredUpdatePath(home), '{not json\n')
    expect(readOfferedUpdateSha(home)).toBeUndefined()
  })
})

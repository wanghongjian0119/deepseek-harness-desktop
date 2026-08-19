import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PAYLOAD_FORMAT,
  dshHome,
  payloadsDir,
  readCurrentPointer,
  readPayloadManifest,
  resolvePayloadRoot,
  switchCurrentPointer,
} from '../src/payload.ts'

let tmp: string
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'dsh-desktop-payload-'))
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

/** Write a payload manifest into a dir so it resolves as a payload root. */
async function seedManifest(dir: string, sourceRef?: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const manifest: Record<string, unknown> = {
    format: PAYLOAD_FORMAT,
    cliEntry: 'cli/lib/bin.js',
    nodeBinary: 'node/bin/node',
  }
  if (sourceRef !== undefined) manifest.sourceRef = sourceRef
  await writeFile(join(dir, 'payload.json'), `${JSON.stringify(manifest)}\n`)
}

describe('readPayloadManifest', () => {
  it('parses a valid manifest', async () => {
    await writeFile(join(tmp, 'payload.json'), JSON.stringify({
      format: PAYLOAD_FORMAT,
      cliEntry: 'cli/lib/bin.js',
      nodeBinary: 'node/bin/node',
      sourceRef: 'a'.repeat(40),
    }))
    expect(readPayloadManifest(tmp)).toEqual({
      format: PAYLOAD_FORMAT,
      cliEntry: 'cli/lib/bin.js',
      nodeBinary: 'node/bin/node',
      sourceRef: 'a'.repeat(40),
    })
  })

  it('treats sourceRef as optional', async () => {
    await writeFile(join(tmp, 'payload.json'), JSON.stringify({
      format: PAYLOAD_FORMAT,
      cliEntry: 'cli/lib/bin.js',
      nodeBinary: 'node/bin/node',
    }))
    expect(readPayloadManifest(tmp).sourceRef).toBeUndefined()
  })

  it('rejects an unknown format', async () => {
    await writeFile(join(tmp, 'payload.json'), JSON.stringify({ format: 99, cliEntry: 'a', nodeBinary: 'b' }))
    expect(() => readPayloadManifest(tmp)).toThrow(/format 99 is not supported/)
  })

  it('rejects a manifest without entry paths', async () => {
    await writeFile(join(tmp, 'payload.json'), JSON.stringify({ format: PAYLOAD_FORMAT }))
    expect(() => readPayloadManifest(tmp)).toThrow(/missing cliEntry/)
  })

  it('throws on a missing manifest file', () => {
    expect(() => readPayloadManifest(join(tmp, 'nope'))).toThrow()
  })
})

describe('dshHome and payload pointers', () => {
  it('defaults to ~/.dsh and honors DSH_HOME', () => {
    expect(dshHome({})).toBe(join(homedir(), '.dsh'))
    expect(dshHome({ DSH_HOME: '/custom/home' })).toBe('/custom/home')
  })

  it('round-trips the current pointer', async () => {
    expect(readCurrentPointer(tmp)).toBeUndefined()
    switchCurrentPointer(tmp, 'a'.repeat(40))
    expect(readCurrentPointer(tmp)).toBe('a'.repeat(40))
  })

  it('rejects unsafe pointer refs', () => {
    expect(() => { switchCurrentPointer(tmp, '../evil') }).toThrow(/invalid payload ref/)
    expect(() => { switchCurrentPointer(tmp, 'a b') }).toThrow(/invalid payload ref/)
  })

  it('ignores a corrupt pointer file', async () => {
    await mkdir(payloadsDir(tmp), { recursive: true })
    await writeFile(join(payloadsDir(tmp), 'current'), 'not-a-valid-ref!!')
    expect(readCurrentPointer(tmp)).toBeUndefined()
  })
})

describe('resolvePayloadRoot', () => {
  it('honors DSH_DESKTOP_PAYLOAD over everything', async () => {
    await seedManifest(tmp)
    await seedManifest(join(tmp, 'other'))
    expect(resolvePayloadRoot(undefined, { DSH_DESKTOP_PAYLOAD: tmp }, '/nowhere')).toBe(tmp)
  })

  it('prefers the pointer-installed payload over the bundled seed', async () => {
    await seedManifest(join(tmp, 'bundled'), 'b'.repeat(40))
    const installed = join(payloadsDir(tmp), 'c'.repeat(40))
    await seedManifest(installed, 'c'.repeat(40))
    switchCurrentPointer(tmp, 'c'.repeat(40))
    expect(resolvePayloadRoot(join(tmp, 'bundled'), {}, '/nowhere', tmp)).toBe(installed)
  })

  it('falls back to the bundled seed without a pointer', async () => {
    const bundled = join(tmp, 'bundled')
    await seedManifest(bundled)
    expect(resolvePayloadRoot(bundled, {}, '/nowhere', tmp)).toBe(bundled)
  })

  it('ignores a pointer whose payload dir is missing', async () => {
    const bundled = join(tmp, 'bundled')
    await seedManifest(bundled)
    switchCurrentPointer(tmp, 'a'.repeat(40))
    expect(resolvePayloadRoot(bundled, {}, '/nowhere', tmp)).toBe(bundled)
  })

  it('falls back to the staged payload under the working directory', async () => {
    const stage = join(tmp, '.stage', 'dsh')
    await seedManifest(stage)
    expect(resolvePayloadRoot(undefined, {}, tmp)).toBe(stage)
  })

  it('returns undefined when nothing exists', () => {
    expect(resolvePayloadRoot(undefined, {}, tmp)).toBeUndefined()
  })
})

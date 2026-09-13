import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { applyBrandTweaks } from '../src/payload-builder.ts'

const SIDEBAR_RELATIVE = ['runtime', 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar', 'lib', 'client.js']
const LOCALE_RELATIVE = ['runtime', 'node_modules', '@deepseek-ai', 'dsh-client-locale', 'lib', 'client.js']

/** The `..._logoRow` rule both variants share, which clips a taller brand row. */
const logoRow = (prefix: string): string =>
  `.${prefix}_logoRow{box-sizing:border-box;flex:none;justify-content:flex-end;align-items:center;gap:8px;height:60px;margin-bottom:8px;padding:8px 0 8px 4px;display:flex;overflow:hidden}`

/**
 * Sidebar CSS as upstream emits it for a source build — the variant a desktop
 * payload is assembled from. The class-name prefix is a per-build hash, so a
 * patch that hard-coded `ViNb6q_` would work exactly once; the cases below vary
 * it to catch that.
 */
const sourceBuildCss = (prefix: string): string => [
  logoRow(prefix),
  `.${prefix}_brandIdentity{align-items:center;gap:8px;min-width:0;height:24px;display:inline-flex}`,
  `.${prefix}_brandName{letter-spacing:.04em;align-items:center;gap:6px;min-width:0;height:24px;font-size:18px;font-weight:600;line-height:24px;display:inline-flex}`,
  `.${prefix}_fallbackBrandName{letter-spacing:0;white-space:nowrap;font-size:17px}`,
  `.${prefix}_localBuildBrand{white-space:nowrap;flex-direction:column;flex:none;justify-content:center;align-items:flex-start;gap:1px;height:24px;display:inline-flex}`,
  `.${prefix}_localBuildTitle{letter-spacing:0;font-size:12px;line-height:13px}`,
  `.${prefix}_buildVersion{height:10px;color:var(--dsw-alias-label-primary-inverted);background:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code);white-space:nowrap;border-radius:2px;flex:none;align-items:center;padding:0 3px;font-size:6px;font-weight:500;line-height:10px;display:inline-flex}`,
].join('')

/**
 * Sidebar CSS as upstream emits it for a release build: no stacked row, and an
 * 8px/16px chip beside the name inside the 24px brand box.
 */
const releaseBuildCss = (prefix: string): string => [
  logoRow(prefix),
  `.${prefix}_brandIdentity{align-items:center;gap:8px;min-width:0;height:24px;display:inline-flex}`,
  `.${prefix}_brandName{letter-spacing:.04em;align-items:center;gap:6px;min-width:0;height:24px;font-size:18px;font-weight:600;line-height:24px;display:inline-flex}`,
  `.${prefix}_fallbackBrandName{letter-spacing:0;white-space:nowrap;font-size:17px}`,
  `.${prefix}_buildRevision{height:16px;color:var(--dsw-alias-label-primary-inverted);background:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code);border-radius:3px;align-items:center;padding:0 4px;font-size:8px;font-weight:500;line-height:16px;display:inline-flex}`,
].join('')

/** Both locale dictionaries, laid out the way the built bundle writes them. */
const upstreamLocale = (): string => [
  'export const zh = {',
  '\t"session.new": "新会话",',
  '\t"brand.localBuild": "DSH 本地构建",',
  '};',
  'export const en = {',
  '\t"session.new": "New Session",',
  '\t"brand.localBuild": "DSH Local Build",',
  '};',
].join('\n')

/** Stage a payload root holding whichever bundles the case under test needs. */
function makePayload(files: { sidebar?: string; locale?: string }): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-brand-'))
  if (files.sidebar !== undefined) {
    const file = join(root, ...SIDEBAR_RELATIVE)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, files.sidebar)
  }
  if (files.locale !== undefined) {
    const file = join(root, ...LOCALE_RELATIVE)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, files.locale)
  }
  return root
}

const read = (root: string, relative: string[]): string => readFileSync(join(root, ...relative), 'utf8')

/** The body of one `..._suffix{...}` rule, so a case can assert on declarations alone. */
const ruleBody = (css: string, suffix: string): string => {
  const body = new RegExp(`[A-Za-z0-9]+_${suffix}\\{([^}]*)\\}`).exec(css)?.[1]
  if (body === undefined) throw new Error(`no _${suffix} rule in the patched CSS`)
  return body
}

/** Run the tweak over a payload staged with one sidebar fixture. */
async function patchSidebar(sidebar: string): Promise<string> {
  const root = makePayload({ sidebar })
  await applyBrandTweaks(root)
  return read(root, SIDEBAR_RELATIVE)
}

describe('applyBrandTweaks', () => {
  it('retitles both locale dictionaries, leaving their other entries alone', async () => {
    const root = makePayload({ locale: upstreamLocale() })
    try {
      await applyBrandTweaks(root)
      const locale = read(root, LOCALE_RELATIVE)
      expect(locale).toContain('"brand.localBuild": "DeepSeek Harness"')
      expect(locale).not.toContain('DSH 本地构建')
      expect(locale).not.toContain('DSH Local Build')
      // The patch must not touch a neighbouring key or the file's layout.
      expect(locale).toContain('"session.new": "新会话"')
      expect(locale).toContain('"session.new": "New Session"')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('grows the stacked row and its wrappers to hold the pinned title and chip', async () => {
    const css = await patchSidebar(sourceBuildCss('cguSKG'))
    expect(css).toContain('.cguSKG_localBuildBrand{white-space:nowrap;flex-direction:column;flex:none;justify-content:center;align-items:flex-start;gap:1px;height:33px;display:inline-flex}')
    expect(css).toContain('.cguSKG_brandIdentity{align-items:center;gap:8px;min-width:0;height:33px;display:inline-flex}')
    expect(css).toContain('.cguSKG_brandName{letter-spacing:.04em;align-items:center;gap:6px;min-width:0;height:33px;font-size:18px;font-weight:600;line-height:24px;display:inline-flex}')
  })

  it('enlarges the local-build title to the release size', async () => {
    const css = await patchSidebar(sourceBuildCss('cguSKG'))
    expect(css).toContain('.cguSKG_localBuildTitle{letter-spacing:0;font-size:17px;line-height:18px}')
  })

  it('grows the source build chip and paints it brand blue', async () => {
    const chip = ruleBody(await patchSidebar(sourceBuildCss('cguSKG')), 'buildVersion')
    expect(chip).toContain('font-size:10px')
    expect(chip).toContain('line-height:14px')
    expect(chip).toContain('height:14px')
    expect(chip).toContain('border-radius:3px')
    expect(chip).toContain('padding:0 4px')
    expect(chip).toContain('color:#fff')
    expect(chip).toContain('background:var(--dsw-static-deepseek-450)')
    // Every declaration the patch does not own survives verbatim.
    expect(chip).toContain('font-family:var(--ds-font-family-code)')
    expect(chip).toContain('font-weight:500')
  })

  it('grows the release chip type without resizing the box it sits in', async () => {
    const css = await patchSidebar(releaseBuildCss('q0C6NW'))
    const chip = ruleBody(css, 'buildRevision')
    expect(chip).toContain('font-size:10px')
    expect(chip).toContain('height:16px')
    expect(chip).toContain('line-height:16px')
    expect(chip).toContain('color:#fff')
    expect(chip).toContain('background:var(--dsw-static-deepseek-450)')
    // A release build's row already fits the chip, so the patch must not move it.
    expect(css).toContain('.q0C6NW_brandIdentity{align-items:center;gap:8px;min-width:0;height:24px;display:inline-flex}')
    expect(css).toContain('.q0C6NW_brandName{letter-spacing:.04em;align-items:center;gap:6px;min-width:0;height:24px;font-size:18px;font-weight:600;line-height:24px;display:inline-flex}')
  })

  it('does not match the release-path fallback through the `_brandName` rule', async () => {
    const css = await patchSidebar(releaseBuildCss('q0C6NW'))
    expect(css).toContain('.q0C6NW_fallbackBrandName{letter-spacing:0;white-space:nowrap;font-size:17px}')
  })

  it('matches whatever hash prefix the bundle was built with', async () => {
    const css = await patchSidebar(sourceBuildCss('vDdT8q'))
    expect(css).toContain('.vDdT8q_localBuildTitle{letter-spacing:0;font-size:17px;line-height:18px}')
    expect(css).toContain('.vDdT8q_brandName{letter-spacing:.04em;align-items:center;gap:6px;min-width:0;height:33px;font-size:18px;font-weight:600;line-height:24px;display:inline-flex}')
  })

  it('is idempotent', async () => {
    const root = makePayload({ sidebar: sourceBuildCss('cguSKG'), locale: upstreamLocale() })
    try {
      await applyBrandTweaks(root)
      const sidebar = read(root, SIDEBAR_RELATIVE)
      const locale = read(root, LOCALE_RELATIVE)
      await applyBrandTweaks(root)
      expect(read(root, SIDEBAR_RELATIVE)).toBe(sidebar)
      expect(read(root, LOCALE_RELATIVE)).toBe(locale)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves the bundles alone when upstream markup does not match', async () => {
    const rewritten = '.whatever_root{color:red}'
    const renamed = 'export const zh = { "brand.somethingElse": "DSH 本地构建" };'
    const root = makePayload({ sidebar: rewritten, locale: renamed })
    try {
      await expect(applyBrandTweaks(root)).resolves.toBeUndefined()
      expect(read(root, SIDEBAR_RELATIVE)).toBe(rewritten)
      expect(read(root, LOCALE_RELATIVE)).toBe(renamed)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips a bundle that is absent without touching the other', async () => {
    const root = makePayload({ sidebar: sourceBuildCss('cguSKG') })
    try {
      await expect(applyBrandTweaks(root)).resolves.toBeUndefined()
      expect(read(root, SIDEBAR_RELATIVE)).toContain('cguSKG_buildVersion')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips quietly when neither bundle is present', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-brand-empty-'))
    try {
      await expect(applyBrandTweaks(root)).resolves.toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * Detect whether a served GUI index carries the host-injected boot manifest.
 *
 * Older hosts inject `window.__DSH_BOOT__ = …`; current upstream
 * `dsh-host-webserver` renders `kind: 'global'` as
 * `globalThis["__DSH_BOOT__"] = …`. Both assign the same wire name the shell
 * reads before mounting.
 * @module @deepseek-ai/dsh-desktop/boot-manifest
 */

/**
 * Whether HTML from `GET /` includes a host-injected `__DSH_BOOT__` assignment.
 * @param html - the index document body.
 * @returns true when either known injection form is present.
 */
export function indexCarriesBootManifest(html: string): boolean {
  if (html.includes('window.__DSH_BOOT__')) return true
  // webserver global injection: globalThis["__DSH_BOOT__"] or globalThis['__DSH_BOOT__']
  if (html.includes('globalThis["__DSH_BOOT__"]') || html.includes("globalThis['__DSH_BOOT__']")) {
    return true
  }
  return false
}

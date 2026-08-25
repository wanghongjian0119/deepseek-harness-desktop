/**
 * Decide whether a renderer-initiated window.open URL may leave the app via
 * the system browser. Loopback and same-origin URLs stay inside Electron —
 * the desktop shell already shows the GUI; handing those to Firefox/Chrome
 * duplicates the surface.
 * @module @deepseek-ai/dsh-desktop/external-url
 */

/**
 * Whether `url` should be passed to `shell.openExternal`.
 * @param url - candidate from `setWindowOpenHandler`.
 * @param appOrigin - current GUI origin (e.g. `http://127.0.0.1:38763`), or `''` before ready.
 * @returns true only for non-loopback http(s) URLs that are not the app origin.
 */
export function shouldOpenExternally(url: string, appOrigin: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1') {
    return false
  }
  if (appOrigin !== '' && url.startsWith(appOrigin)) return false
  return true
}

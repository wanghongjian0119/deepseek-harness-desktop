/**
 * Readiness-line parsing for the `dsh web` backend.
 *
 * The web-app bundle prints the canonical loopback URL on stdout after the
 * Loader tree settles (`dsh web: http://127.0.0.1:<port>[/?token=...]`); the
 * desktop shell treats that line as the readiness signal and the URL as the
 * window target. Newer backends append a boot token query to the loopback URL
 * and 401 requests without it, so the token must be kept: the smoke handshake
 * and the GUI window both need it to authenticate.
 * @module @deepseek-ai/dsh-desktop/url-line
 */

/**
 * Match the URL line, keeping any boot-token query while still tolerating the
 * optional LAN suffix printed after the loopback URL.
 */
const URL_LINE_PATTERN = /dsh web: (http:\/\/127\.0\.0\.1:\d+[^\s]*)/

/**
 * Extract the served loopback URL from one backend stdout line.
 * @param line - one line of `dsh web` stdout.
 * @returns the loopback URL, or `undefined` when the line is not the URL line.
 */
export function parseUrlLine(line: string): string | undefined {
  const match = URL_LINE_PATTERN.exec(line)
  return match?.[1]
}

/**
 * Rasterize the web favicon into the desktop app icon set.
 *
 * electron-builder derives .icns/.ico from a single 1024x1024 PNG in
 * `apps/desktop/build/icon.png` (buildResources). The only brand asset is the
 * SVG favicon — a black whale on transparency, with a dark-mode white
 * variant. The desktop icon composits the white whale onto a rounded-square
 * DeepSeek Blue (#4D6BFE) background, so it stays legible on both light and
 * dark taskbars and docks; the corners stay transparent, matching the
 * rounded-square convention of modern app icons.
 * @module @deepseek-ai/dsh-desktop/make-icon
 */

import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const ICON_SIZE = 1024
/** Rounded-corner radius: ~22.5% of the size, the standard app-icon square. */
const CORNER_RADIUS = 230
/** The whale occupies 58% of the canvas, centered. */
const WHALE_FRACTION = 0.58
/** DeepSeek's official brand blue. */
const BRAND_BLUE = '#4D6BFE'
/** Standard icon-theme sizes shipped for Linux. */
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

/** Force the favicon's white (dark-mode) variant, drop the media query, and return only the inner body. */
function whiteWhaleSvg(source: string): string {
  const withoutStyle = source.replace(/<style>[\s\S]*?<\/style>/, '')
  const white = withoutStyle.replace(/fill="#000"/g, 'fill="#fff"')
  return white.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '')
}

const rawFavicon = await readFile(join(root, 'apps/web/public/favicon.svg'), 'utf8')
const whale = whiteWhaleSvg(rawFavicon)
const whaleSize = Math.round(ICON_SIZE * WHALE_FRACTION)
const offset = Math.round((ICON_SIZE - whaleSize) / 2)
const scale = whaleSize / 50 // the favicon's viewBox is 50x50

const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 ${ICON_SIZE} ${ICON_SIZE}">
  <rect x="0" y="0" width="${ICON_SIZE}" height="${ICON_SIZE}" rx="${CORNER_RADIUS}" fill="${BRAND_BLUE}"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})">${whale}</g>
</svg>`

const outDir = join(root, 'apps/desktop/build')
const iconsDir = join(outDir, 'icons')
await mkdir(outDir, { recursive: true })
await mkdir(iconsDir, { recursive: true })
const master = sharp(Buffer.from(iconSvg), { density: 300 }).resize(ICON_SIZE, ICON_SIZE)
await master.clone().png().toFile(join(outDir, 'icon.png'))
for (const size of ICON_SIZES) {
  await master.clone().resize(size, size).png().toFile(join(iconsDir, `${size}x${size}.png`))
}
console.log(`make-icon: wrote ${join(outDir, 'icon.png')} and ${ICON_SIZES.length} size icons in ${join(iconsDir)} (${BRAND_BLUE} rounded square + white whale)`)

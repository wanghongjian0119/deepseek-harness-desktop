/**
 * Electron main process for the DeepSeek Harness desktop app.
 *
 * Responsibilities: resolve the self-contained backend payload, spawn the
 * bundled `dsh web` server, and open a native window at the served URL once
 * the readiness line appears. Lifecycle keeps the backend and the window
 * bound: closing the window quits the app, quitting stops the backend, a
 * second instance focuses the existing window, and a backend that dies or
 * fails to boot surfaces an actionable error dialog with a restart path.
 *
 * Source self-update: on launch (and every few hours) the shell compares the
 * payload's recorded source ref with the upstream master commit. When newer
 * code exists it opens the in-app Update Center (not a system notification).
 * From there the user can check, download, install, and watch progress; on
 * success the backend restarts on the new payload. The Electron shell itself
 * is not updated — only the bundled backend.
 *
 * The renderer is the plain remote web app over `http://127.0.0.1`; the
 * window is a sandboxed, nodeIntegration-free shell around it.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { app, dialog, shell, BrowserWindow, Menu } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PayloadManifest } from './payload.ts'
import { dshHome, readPayloadManifest, resolvePayloadRoot } from './payload.ts'
import { launchServer, type ServerHandle } from './server-launcher.ts'
import { shouldOpenExternally } from './external-url.ts'
import { UpdateCenter } from './updater/update-center.ts'
import { checkForUpdate } from './updater/update-check.ts'
import { readOfferedUpdateSha, writeOfferedUpdateSha } from './updater/offered-update.ts'

/** Launcher flag that switches payload resolution to development mode. */
const DEV_FLAG = '--dev'

/** How often to re-check for updates while the app runs. */
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Inline loading page shown while the backend boots. */
const LOADING_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<!doctype html><html><head><meta charset="utf-8"><style>'
  + 'html,body{height:100%;margin:0;background:#0d1117;color:#c9d1d9;font-family:system-ui,sans-serif}'
  + 'body{display:flex;align-items:center;justify-content:center}'
  + '</style></head><body>Starting DeepSeek Harness&hellip;</body></html>',
)}`

let mainWindow: BrowserWindow | undefined
let server: ServerHandle | undefined
let appOrigin = ''
let stopping = false
/** True while a backend stop is initiated by this shell, suppressing the unexpected-exit dialog. */
let backendIntentionalStop = false
/** The active payload (root + manifest), refreshed on every backend start. */
let activePayload: { root: string; manifest: PayloadManifest } | undefined
/** True while a background availability check is in flight. */
let updateCheckBusy = false
/** Latest SHA already auto-offered in the Update Center (memory + `$DSH_HOME/desktop/offered-update.json`). */
let offeredUpdateSha: string | undefined

const updateCenter = new UpdateCenter({
  getPayload: () => activePayload,
  getParentWindow: () => mainWindow,
  restartBackend: async () => {
    await stopBackend()
    await startBackend()
  },
})

/**
 * The app icon for the window/taskbar: the packaged `Resources/icon.png`
 * (extraResources), or the repo's `build/icon.png` in a source checkout.
 * macOS derives the dock icon from the bundle; Linux/Windows use this.
 */
function windowIconPath(): string | undefined {
  const packaged = join(process.resourcesPath, 'icon.png')
  if (existsSync(packaged)) return packaged
  const dev = fileURLToPath(new URL('../build/icon.png', import.meta.url))
  return existsSync(dev) ? dev : undefined
}

/** Create the app window: sandboxed renderer, no navigation off the app origin. */
function createWindow(): BrowserWindow {
  const icon = windowIconPath()
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    // Keep the menu bar visible: Linux users otherwise only get Alt-to-reveal,
    // which hides Update Center behind an invisible chrome affordance.
    autoHideMenuBar: false,
    title: 'DeepSeek Harness',
    ...(icon !== undefined ? { icon } : {}),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => { win.show() })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenExternally(url, appOrigin)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (appOrigin !== '' && !url.startsWith(appOrigin)) event.preventDefault()
  })
  return win
}

/** Present a fatal error with a restart path and act on the choice. */
async function fatal(title: string, detail: string): Promise<void> {
  if (mainWindow === undefined || mainWindow.isDestroyed()) {
    dialog.showErrorBox(title, detail)
    app.exit(1)
    return
  }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'error',
    title,
    message: title,
    detail,
    buttons: ['Restart', 'Quit'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response === 0) {
    await stopBackend()
    await startBackend()
  } else {
    app.quit()
  }
}

/** Stop the running backend, if any. */
async function stopBackend(): Promise<void> {
  const current = server
  server = undefined
  if (current !== undefined) {
    backendIntentionalStop = true
    await current.stop()
  }
}

/** Resolve the payload, spawn the backend, and load its URL into the window. */
async function startBackend(): Promise<void> {
  const packagedRoot = process.argv.includes(DEV_FLAG) ? undefined : join(process.resourcesPath, 'dsh')
  const payloadRoot = resolvePayloadRoot(packagedRoot)
  if (payloadRoot === undefined) {
    await fatal(
      'DeepSeek Harness payload is missing',
      'The bundled backend was not found. Reinstall the application, or in a source checkout run '
      + '`pnpm --filter @deepseek-ai/dsh-desktop run build:payload` and relaunch with `pnpm --filter @deepseek-ai/dsh-desktop run dev`.',
    )
    return
  }
  let manifest: PayloadManifest
  try {
    manifest = readPayloadManifest(payloadRoot)
  } catch (error) {
    await fatal('DeepSeek Harness payload is invalid', String(error))
    return
  }
  activePayload = { root: payloadRoot, manifest }
  backendIntentionalStop = false
  server = launchServer({
    nodeBinary: join(payloadRoot, manifest.nodeBinary),
    cliEntry: join(payloadRoot, manifest.cliEntry),
    onLine: (line) => { console.log('[dsh web]', line) },
  })
  void server.exited.then(({ code, signal }) => {
    if (backendIntentionalStop) return
    void fatal(
      'DeepSeek Harness backend stopped',
      `The backend exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'null'}). Restart it to continue.`,
    )
  })
  try {
    const url = await server.url
    appOrigin = new URL(url).origin
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) await mainWindow.loadURL(url)
    // The first update check happens after the GUI is up; later ones on an
    // interval. Only payloads that record a source ref participate.
    if (manifest.sourceRef !== undefined) void scheduleUpdateCheck()
  } catch (error) {
    await fatal('DeepSeek Harness failed to start', String(error))
  }
}

/** Check upstream once and open the Update Center when newer code exists. */
async function scheduleUpdateCheck(): Promise<void> {
  if (updateCheckBusy || activePayload?.manifest.sourceRef === undefined) return
  updateCheckBusy = true
  try {
    const home = dshHome()
    if (offeredUpdateSha === undefined) offeredUpdateSha = readOfferedUpdateSha(home)
    const result = await checkForUpdate({ currentSha: activePayload.manifest.sourceRef })
    if (result.available && result.latestSha !== undefined && result.latestSha !== offeredUpdateSha) {
      offeredUpdateSha = result.latestSha
      writeOfferedUpdateSha(result.latestSha, home)
      updateCenter.open({ autoCheck: true })
    }
  } catch (error) {
    // A failed check (offline, API limit) is not an error surface; the next
    // interval or a manual menu click retries.
    console.log('[update] check failed:', error instanceof Error ? error.message : String(error))
  } finally {
    updateCheckBusy = false
  }
}

/** Build the always-visible application menu. */
function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '更新',
      submenu: [
        { label: '打开更新中心', accelerator: 'CmdOrCtrl+U', click: () => { updateCenter.open({ autoCheck: true }) } },
      ],
    },
  ]))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow !== undefined) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  void app.whenReady().then(() => {
    app.setAppUserModelId('ai.deepseek.harness')
    updateCenter.installIpc()
    installMenu()
    mainWindow = createWindow()
    mainWindow.setAutoHideMenuBar(false)
    mainWindow.setMenuBarVisibility(true)
    void mainWindow.loadURL(LOADING_HTML)
    void startBackend()
    setInterval(() => { void scheduleUpdateCheck() }, UPDATE_CHECK_INTERVAL_MS)
  })
  // Quit on close on every platform: the app IS the window for v1, so a
  // closed window must not leave an orphan backend or a dock ghost.
  app.on('window-all-closed', () => {
    app.quit()
  })
  app.on('will-quit', (event) => {
    if (stopping) return
    event.preventDefault()
    stopping = true
    void stopBackend().finally(() => {
      app.quit()
    })
  })
  // Last-resort sync kill for hard exits that never reach will-quit.
  process.on('exit', () => {
    try {
      server?.child.kill('SIGKILL')
    } catch {
      // The child may already be gone; the exit path must not throw.
    }
  })
}

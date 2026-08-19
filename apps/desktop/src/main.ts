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
 * payload's recorded source ref with the upstream master commit; when newer
 * code exists it notifies the user, and on confirmation downloads the source,
 * rebuilds the payload, and restarts the backend with the new version. The
 * Electron shell itself is not updated — only the bundled backend.
 *
 * The renderer is the plain remote web app over `http://127.0.0.1`; the
 * window is a sandboxed, nodeIntegration-free shell around it.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { app, dialog, shell, BrowserWindow, Menu, Notification } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PayloadManifest } from './payload.ts'
import { dshHome, readPayloadManifest, resolvePayloadRoot } from './payload.ts'
import { launchServer, type ServerHandle } from './server-launcher.ts'
import { checkForUpdate, updateRepo } from './updater/update-check.ts'
import { runSourceUpdate, type UpdateProgress } from './updater/update-job.ts'

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

/** Inline progress page shown while an update builds. */
const PROGRESS_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<!doctype html><html><head><meta charset="utf-8"><style>'
  + 'html,body{height:100%;margin:0;background:#0d1117;color:#c9d1d9;font-family:system-ui,sans-serif}'
  + 'body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px}'
  + '#status{font-size:14px;text-align:center;white-space:pre-wrap;word-break:break-all}'
  + '</style></head><body><div id="status">准备更新&hellip;</div></body></html>',
)}`

let mainWindow: BrowserWindow | undefined
let server: ServerHandle | undefined
let appOrigin = ''
let stopping = false
/** True while a backend stop is initiated by this shell, suppressing the unexpected-exit dialog. */
let backendIntentionalStop = false
/** The active payload (root + manifest), refreshed on every backend start. */
let activePayload: { root: string; manifest: PayloadManifest } | undefined
/** Guards against overlapping update prompts and runs. */
let updateBusy = false
let progressWindow: BrowserWindow | undefined

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
    autoHideMenuBar: true,
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
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
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

// ── source self-update ──────────────────────────────────────────────────────

/** Small update-progress window; text is set via executeJavaScript. */
function createProgressWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 460,
    height: 180,
    resizable: false,
    autoHideMenuBar: true,
    title: '更新 DeepSeek Harness',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  void win.loadURL(PROGRESS_HTML)
  progressWindow = win
  win.once('closed', () => { progressWindow = undefined })
  return win
}

/** Show a line in the progress window, if one is open. */
function setProgressText(text: string): void {
  progressWindow?.webContents.executeJavaScript(
    `document.getElementById('status').textContent = ${JSON.stringify(text)}`,
  ).catch(() => {})
}

/** Check upstream once and, if newer code exists, offer the update. */
async function scheduleUpdateCheck(): Promise<void> {
  if (updateBusy || activePayload?.manifest.sourceRef === undefined) return
  try {
    const result = await checkForUpdate({ currentSha: activePayload.manifest.sourceRef })
    if (result.available) {
      const notification = new Notification({
        title: '发现新版本',
        body: `官方代码已更新（${result.latestSha?.slice(0, 12)}），点击查看并更新。`,
      })
      notification.on('click', () => { void offerUpdate() })
      notification.show()
    }
  } catch (error) {
    // A failed check (offline, API limit) is not an error surface; the next
    // interval or a manual menu click retries.
    console.log('[update] check failed:', error instanceof Error ? error.message : String(error))
  }
}

/** Ask the user whether to update now; on confirmation run the update. */
async function offerUpdate(): Promise<void> {
  if (updateBusy || activePayload === undefined) return
  updateBusy = true
  try {
    const currentSha = activePayload.manifest.sourceRef
    const latest = await checkForUpdate(currentSha === undefined ? {} : { currentSha })
    if (!latest.available || latest.latestSha === undefined) return
    const { response } = await dialog.showMessageBox(mainWindow ?? createWindow(), {
      type: 'question',
      title: '发现新版本',
      message: `官方代码已更新到 ${latest.latestSha.slice(0, 12)}`,
      detail: '将下载最新源码并重新构建后端（需要联网，通常需要几分钟，完成后应用会自动重启）。期间可以继续使用当前版本。',
      buttons: ['立即更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response !== 0) return
    await startUpdate(latest.latestSha)
  } catch (error) {
    await dialog.showMessageBox(mainWindow ?? createWindow(), {
      type: 'error',
      title: '检查更新失败',
      message: String(error),
    })
  } finally {
    updateBusy = false
  }
}

/** Download, build, activate, and switch to a new payload. */
async function startUpdate(targetSha: string): Promise<void> {
  const current = activePayload
  if (current === undefined) return
  const progress = createProgressWindow()
  try {
    const result = await runSourceUpdate({
      repo: updateRepo(),
      targetSha,
      home: dshHome(),
      workDir: join(dshHome(), 'desktop', 'update-work'),
      currentNodeBinary: join(current.root, current.manifest.nodeBinary),
      onProgress: (p: UpdateProgress) => { setProgressText(p.detail) },
      onLog: (line) => { console.log('[update]', line) },
    })
    setProgressText('更新完成，正在重启…')
    await stopBackend()
    await startBackend()
    new Notification({ title: '更新完成', body: `已切换到 ${result.sourceRef.slice(0, 12)}。` }).show()
  } catch (error) {
    await dialog.showMessageBox(mainWindow ?? progress, {
      type: 'error',
      title: '更新失败',
      message: '保留当前版本。\n\n' + String(error),
    })
  } finally {
    if (!progress.isDestroyed()) progress.close()
  }
}

/** Build the minimal application menu: update control plus quit. */
function installMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'DeepSeek Harness',
      submenu: [
        { label: '检查更新…', click: () => { void offerUpdate() } },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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
    installMenu()
    mainWindow = createWindow()
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

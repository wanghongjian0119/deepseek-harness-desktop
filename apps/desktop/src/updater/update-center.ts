/**
 * In-app Update Center for the desktop shell.
 *
 * Linux desktop notifications are unreliable for this product (often filtered,
 * click handlers never fire, or the toast is easy to miss). The Update Center
 * is a dedicated BrowserWindow owned by the shell: check, download, install,
 * and progress all live there. The remote Web GUI never sees these APIs.
 * @module @deepseek-ai/dsh-desktop/update-center
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PayloadManifest } from '../payload.ts'
import { dshHome } from '../payload.ts'
import { checkForUpdate, updateRepo } from './update-check.ts'
import { DEFAULT_NPM_MIRROR_ID, NPM_MIRRORS, resolveNpmRegistry, type NpmMirror } from './npm-mirrors.ts'
import { runSourceUpdate, type UpdateProgress } from './update-job.ts'

/** Phases shown by the Update Center UI. */
export type UpdateCenterPhase =
  | 'idle'
  | 'checking'
  | 'download-source'
  | 'extract'
  | 'install'
  | 'build'
  | 'assemble'
  | 'finalize'
  | 'done'
  | 'error'

/** Snapshot pushed to the Update Center renderer. */
export interface UpdateCenterState {
  repo: string
  currentSha: string | undefined
  latestSha: string | undefined
  available: boolean
  busy: boolean
  phase: UpdateCenterPhase
  message: string
  messageKind: 'busy' | 'ok' | 'warn' | 'err'
  /** Selected npm mirror id. */
  registryId: string
  /** Mirrors offered by the UI. */
  mirrors: readonly NpmMirror[]
}

/** Dependencies the Update Center needs from the main process. */
export interface UpdateCenterHost {
  /** Active payload, if the backend has started. */
  getPayload: () => { root: string; manifest: PayloadManifest } | undefined
  /** Stop the backend before swapping, then start it again. */
  restartBackend: () => Promise<void>
  /** Optional parent window for positioning / modality hints. */
  getParentWindow: () => BrowserWindow | undefined
}

/** Resolve a file under `apps/desktop/preload/` (dev checkout or packaged asar). */
function resolvePreloadAsset(name: string): string {
  const packaged = join(app.getAppPath(), 'preload', name)
  if (existsSync(packaged)) return packaged
  const fromSource = fileURLToPath(new URL(`../../preload/${name}`, import.meta.url))
  if (existsSync(fromSource)) return fromSource
  throw new Error(`update center asset missing: ${name} (looked for ${packaged})`)
}

/** Resolve the Update Center preload script. */
export function resolveUpdateCenterPreload(): string {
  return resolvePreloadAsset('update-center.cjs')
}

/** Resolve the Update Center HTML page. */
export function resolveUpdateCenterHtml(): string {
  return resolvePreloadAsset('update-center.html')
}

/** Shorten a git SHA for display; empty becomes undefined. */
export function shortRef(sha: string | undefined): string | undefined {
  if (sha === undefined || sha === '') return undefined
  return sha.length > 12 ? sha.slice(0, 12) : sha
}

/** Build the initial UI state from the running payload. */
export function initialUpdateCenterState(currentSha: string | undefined): UpdateCenterState {
  return {
    repo: updateRepo(),
    currentSha,
    latestSha: undefined,
    available: false,
    busy: false,
    phase: 'idle',
    message: currentSha === undefined
      ? '当前载荷未记录源码版本，无法自动更新。'
      : '点击「检查更新」对比上游最新提交。',
    messageKind: currentSha === undefined ? 'warn' : 'busy',
    registryId: DEFAULT_NPM_MIRROR_ID,
    mirrors: NPM_MIRRORS,
  }
}

/**
 * Own one Update Center window and its IPC handlers.
 *
 * Call {@link UpdateCenter.installIpc} once at app ready, then
 * {@link UpdateCenter.open} from the menu or an automatic check.
 */
export class UpdateCenter {
  private readonly host: UpdateCenterHost
  private window: BrowserWindow | undefined
  private state: UpdateCenterState
  private ipcInstalled = false

  /**
   * @param host - payload / restart callbacks from the Electron main process.
   */
  constructor(host: UpdateCenterHost) {
    this.host = host
    this.state = initialUpdateCenterState(host.getPayload()?.manifest.sourceRef)
  }

  /** Register IPC handlers once for the app lifetime. */
  installIpc(): void {
    if (this.ipcInstalled) return
    this.ipcInstalled = true
    ipcMain.handle('update-center:get-state', () => this.snapshot())
    ipcMain.handle('update-center:check', async () => this.runCheck())
    ipcMain.handle('update-center:install', async (_event, options?: { registryId?: string }) => this.runInstall(options))
  }

  /** Current state copy for the renderer. */
  snapshot(): UpdateCenterState {
    return { ...this.state }
  }

  /**
   * Open (or focus) the Update Center.
   * @param openOptions.autoCheck - run a check immediately after the page loads.
   */
  open(openOptions: { autoCheck?: boolean } = {}): void {
    this.state = {
      ...this.state,
      repo: updateRepo(),
      currentSha: this.host.getPayload()?.manifest.sourceRef ?? this.state.currentSha,
    }
    if (this.window !== undefined && !this.window.isDestroyed()) {
      this.window.focus()
      this.pushState()
      if (openOptions.autoCheck === true) void this.runCheck()
      return
    }
    const parent = this.host.getParentWindow()
    const windowOptions: Electron.BrowserWindowConstructorOptions = {
      width: 580,
      height: 620,
      minWidth: 480,
      minHeight: 480,
      show: false,
      autoHideMenuBar: true,
      title: '更新中心 — DeepSeek Harness',
      webPreferences: {
        preload: resolveUpdateCenterPreload(),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    }
    if (parent !== undefined && !parent.isDestroyed()) windowOptions.parent = parent
    const win = new BrowserWindow(windowOptions)
    this.window = win
    win.once('ready-to-show', () => { win.show() })
    win.once('closed', () => { this.window = undefined })
    void win.loadFile(resolveUpdateCenterHtml()).then(() => {
      this.pushState()
      if (openOptions.autoCheck === true) void this.runCheck()
    })
  }

  /** Push the current state to the open window. */
  private pushState(): void {
    this.emit({ type: 'state', state: this.snapshot() })
  }

  /** Emit one renderer event. */
  private emit(payload: Record<string, unknown>): void {
    if (this.window === undefined || this.window.isDestroyed()) return
    this.window.webContents.send('update-center:event', payload)
  }

  /** Compare the payload ref with upstream master. */
  private async runCheck(): Promise<UpdateCenterState> {
    if (this.state.busy) return this.snapshot()
    const currentSha = this.host.getPayload()?.manifest.sourceRef
    this.state = {
      ...this.state,
      repo: updateRepo(),
      currentSha,
      busy: true,
      phase: 'checking',
      message: '正在检查更新…',
      messageKind: 'busy',
    }
    this.pushState()
    try {
      const result = await checkForUpdate(currentSha === undefined ? {} : { currentSha })
      const available = result.available
      this.state = {
        ...this.state,
        latestSha: result.latestSha,
        available,
        busy: false,
        phase: 'idle',
        message: available
          ? `发现新版本 ${shortRef(result.latestSha)}，可下载并安装。`
          : result.latestSha === undefined
            ? '未能读取上游提交，请稍后重试。'
            : '已是最新源码版本。',
        messageKind: available ? 'warn' : result.latestSha === undefined ? 'err' : 'ok',
      }
      this.pushState()
      return this.snapshot()
    } catch (error) {
      this.state = {
        ...this.state,
        busy: false,
        phase: 'error',
        available: false,
        message: error instanceof Error ? error.message : String(error),
        messageKind: 'err',
      }
      this.pushState()
      return this.snapshot()
    }
  }

  /** Download, build, activate, and restart into the newer payload. */
  private async runInstall(options: { registryId?: string } = {}): Promise<UpdateCenterState> {
    if (this.state.busy) return this.snapshot()
    const payload = this.host.getPayload()
    const targetSha = this.state.latestSha
    if (payload === undefined || targetSha === undefined || !this.state.available) {
      this.state = {
        ...this.state,
        message: '没有可安装的更新，请先检查更新。',
        messageKind: 'warn',
      }
      this.pushState()
      return this.snapshot()
    }
    const registryId = options.registryId ?? this.state.registryId
    const registryUrl = resolveNpmRegistry(registryId)
    this.state = {
      ...this.state,
      registryId,
      busy: true,
      phase: 'download-source',
      message: '开始下载并安装…',
      messageKind: 'busy',
    }
    this.pushState()
    this.emit({ type: 'log', line: `使用 npm 镜像：${registryUrl}` })
    try {
      await runSourceUpdate({
        repo: updateRepo(),
        targetSha,
        home: dshHome(),
        workDir: join(dshHome(), 'desktop', 'update-work'),
        currentNodeBinary: join(payload.root, payload.manifest.nodeBinary),
        registryUrl,
        onProgress: (progress: UpdateProgress) => {
          this.state = {
            ...this.state,
            phase: progress.stage,
            message: progress.detail,
            messageKind: 'busy',
          }
          this.emit({ type: 'progress', stage: progress.stage, detail: progress.detail })
          this.pushState()
        },
        onLog: (line) => { this.emit({ type: 'log', line }) },
      })
      this.state = {
        ...this.state,
        currentSha: targetSha,
        available: false,
        busy: true,
        phase: 'finalize',
        message: '更新完成，正在重启后端…',
        messageKind: 'ok',
      }
      this.pushState()
      await this.host.restartBackend()
      this.state = {
        ...this.state,
        currentSha: this.host.getPayload()?.manifest.sourceRef ?? targetSha,
        busy: false,
        phase: 'done',
        message: `已切换到 ${shortRef(targetSha)}。`,
        messageKind: 'ok',
      }
      this.pushState()
      return this.snapshot()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emit({ type: 'log', line: message })
      this.state = {
        ...this.state,
        busy: false,
        phase: 'error',
        message: `更新失败，已保留当前版本。\n${message}`,
        messageKind: 'err',
      }
      this.pushState()
      return this.snapshot()
    }
  }
}

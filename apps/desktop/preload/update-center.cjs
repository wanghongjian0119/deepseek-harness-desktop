'use strict'

/**
 * Preload bridge for the in-app Update Center window.
 *
 * The update window is not the remote Web GUI: it is a local page owned by
 * the Electron shell. This bridge exposes a narrow invoke/event API so the
 * page never gets Node or Electron privileged APIs directly.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshUpdate', {
  /** @returns {Promise<object>} */
  getState: () => ipcRenderer.invoke('update-center:get-state'),
  /** @returns {Promise<object>} */
  check: () => ipcRenderer.invoke('update-center:check'),
  /**
   * @param {{ registryId?: string }} [options]
   * @returns {Promise<object>}
   */
  install: (options) => ipcRenderer.invoke('update-center:install', options ?? {}),
  /**
   * Subscribe to progress / status events from the main process.
   * @param {(event: object) => void} callback
   * @returns {() => void} disposer
   */
  onEvent: (callback) => {
    const handler = (_event, payload) => {
      callback(payload)
    }
    ipcRenderer.on('update-center:event', handler)
    return () => {
      ipcRenderer.removeListener('update-center:event', handler)
    }
  },
})

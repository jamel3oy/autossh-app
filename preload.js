'use strict';

/**
 * preload.js — Secure bridge between renderer and main process
 *
 * Runs in an isolated context with access to Node.js / Electron APIs,
 * but exposes only a narrow, typed surface to the renderer via contextBridge.
 *
 * Security notes:
 *  - nodeIntegration is disabled in the renderer (no direct require())
 *  - contextIsolation is enabled (renderer cannot access this scope)
 *  - Only explicitly listed IPC channels are exposed
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tunnelAPI', {

  // ── Tunnel Control ──────────────────────────────────────────────────────────

  /** Start the autossh tunnel */
  startTunnel: (opts) => ipcRenderer.invoke('tunnel:start', opts),

  /** Stop the running tunnel */
  stopTunnel: () => ipcRenderer.invoke('tunnel:stop'),

  /** Query whether a tunnel is currently running */
  getTunnelStatus: () => ipcRenderer.invoke('tunnel:status'),

  // ── Event Listeners ─────────────────────────────────────────────────────────

  /**
   * Register a callback for log lines emitted by the main process.
   * @param {(data: { type: string, message: string, timestamp: string }) => void} callback
   */
  onLog: (callback) => {
    ipcRenderer.on('tunnel:log', (_event, data) => callback(data));
  },

  /**
   * Register a callback for tunnel status changes.
   * @param {(data: { running: boolean }) => void} callback
   */
  onStatus: (callback) => {
    ipcRenderer.on('tunnel:status', (_event, data) => callback(data));
  },

  /** Remove all listeners for the given IPC channel */
  removeAllListeners: (channel) => {
    // Whitelist: only allow removing known channels
    const allowed = ['tunnel:log', 'tunnel:status'];
    if (allowed.includes(channel)) {
      ipcRenderer.removeAllListeners(channel);
    }
  },

  // ── Profile / Config Management ─────────────────────────────────────────────

  /** Persist a named profile */
  saveProfile: (name, config) =>
    ipcRenderer.invoke('config:save', { name, config }),

  /** Load a named profile */
  loadProfile: (name) =>
    ipcRenderer.invoke('config:load', { name }),

  /** Return the list of saved profile names */
  listProfiles: () =>
    ipcRenderer.invoke('config:list'),

  /** Delete a named profile */
  deleteProfile: (name) =>
    ipcRenderer.invoke('config:delete', { name }),

  /** Return the name + config of the last-used profile */
  getLastUsed: () =>
    ipcRenderer.invoke('config:get-last'),

  /** Record which profile was used last */
  setLastUsed: (name) =>
    ipcRenderer.invoke('config:set-last', { name }),

  // ── App / Tray Control ──────────────────────────────────────────────────────

  /** Show (and focus) the main window */
  showWindow: () => ipcRenderer.invoke('app:show-window'),

  /** Gracefully quit the app (stop tunnel, destroy tray, exit) */
  quit: () => ipcRenderer.invoke('app:quit'),

  /**
   * Register a callback for the tray "Start Tunnel" request.
   * Fired when the user clicks "Start Tunnel" from the tray context menu.
   */
  onTrayStartRequested: (callback) => {
    ipcRenderer.on('tray:start-requested', (_event) => callback());
  },
});

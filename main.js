'use strict';

/**
 * main.js — Electron main process
 *
 * Responsibilities:
 *  - Create and manage the BrowserWindow
 *  - Spawn / kill the autossh child process
 *  - Stream stdout/stderr to the renderer via IPC
 *  - Persist tunnel profiles via ConfigManager
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const ConfigManager  = require('./src/configManager');
const { makeTrayPNG } = require('./src/trayIcon');

// ─── Globals ──────────────────────────────────────────────────────────────────

/** @type {BrowserWindow|null} */
let mainWindow = null;

/** @type {import('child_process').ChildProcess|null} */
let autosshProcess = null;

/** @type {ConfigManager} */
let configManager;

/** @type {import('electron').Tray|null} */
let tray = null;

// ─── Tray Images (built once, cached) ─────────────────────────────────────────

let _trayImages = null;
function getTrayImages() {
  if (!_trayImages) {
    // 36×36 buffer → rendered at 18 pt on Retina (scaleFactor 2.0)
    const stoppedImg = nativeImage.createFromBuffer(makeTrayPNG(false, 36), { scaleFactor: 2.0 });
    // Template image: macOS auto-tints for light/dark menu bar & highlights on click
    stoppedImg.setTemplateImage(true);
    const runningImg = nativeImage.createFromBuffer(makeTrayPNG(true, 36), { scaleFactor: 2.0 });
    // Do NOT mark running as template — we want the green colour to show
    _trayImages = { stopped: stoppedImg, running: runningImg };
  }
  return _trayImages;
}

// ─── Tray Menu ─────────────────────────────────────────────────────────────────

/**
 * Rebuild and cache the context menu, then update the icon.
 * Called whenever tunnel state or window visibility changes.
 * @param {boolean} running
 */
function updateTray(running) {
  if (!tray || tray.isDestroyed()) return;

  const imgs = getTrayImages();
  tray.setImage(running ? imgs.running : imgs.stopped);
  tray.setToolTip(`AutoSSH Manager — ${running ? '● Tunnel Running' : '○ Stopped'}`);

  const windowVisible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();

  // Build menu without calling setContextMenu — that API intercepts left-clicks
  // on macOS which causes the icon to "bounce" on every click.
  // We pop the menu manually on right-click instead (see setupTray).
  const menu = Menu.buildFromTemplate([
    {
      label: 'AutoSSH Manager',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: running ? '● Tunnel: Running' : '○ Tunnel: Stopped',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: windowVisible ? 'Hide Window' : 'Show Window',
      click: () => toggleWindow(),
    },
    { type: 'separator' },
    {
      label: 'Start Tunnel',
      enabled: !running,
      click: () => {
        showWindow();
        // Signal renderer to initiate start (renderer has the form values)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tray:start-requested');
        }
      },
    },
    {
      label: 'Stop Tunnel',
      enabled: running,
      click: () => {
        stopAutossh();
        sendLog('info', 'Tunnel stopped from tray menu.');
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => quitApp(),
    },
  ]);

  // Store on the tray instance for the right-click handler
  tray._menu = menu;
}

/** Create the system tray — called once at startup */
function setupTray() {
  const imgs = getTrayImages();
  tray = new Tray(imgs.stopped);
  updateTray(false);

  // Left-click: toggle window
  tray.on('click', () => toggleWindow());

  // Right-click: show context menu (avoids the macOS left-click bounce bug
  // that occurs when setContextMenu() is used)
  tray.on('right-click', () => {
    if (tray._menu) tray.popUpContextMenu(tray._menu);
  });
}

// ─── Window Helpers ────────────────────────────────────────────────────────────

/** Bring the window to front; recreate it if it was destroyed */
function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
  if (app.dock) app.dock.show();
}

/** Toggle the main window between visible and hidden */
function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    showWindow();
  } else if (mainWindow.isVisible()) {
    mainWindow.hide();
    if (app.dock) app.dock.hide();
  } else {
    showWindow();
  }
  // Rebuild menu so Show/Hide label reflects new state
  updateTray(autosshProcess !== null);
}

/** Graceful quit: stop tunnel, destroy tray, exit */
function quitApp() {
  stopAutossh(true);
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
  app.exit(0);
}

// ─── SSH_ASKPASS Helpers ──────────────────────────────────────────────────────

/**
 * Write a password to a temp file and create a tiny shell script that cats it.
 * SSH reads the password by executing the script (SSH_ASKPASS mechanism).
 *
 * @param {string} password
 * @returns {{ scriptFile: string, pwdFile: string }}
 */
function createAskpassHelper(password) {
  const id = crypto.randomBytes(8).toString('hex');
  const tmpDir = os.tmpdir();

  // Store the raw password in a restricted file
  const pwdFile = path.join(tmpDir, `.autossh-pwd-${id}`);
  fs.writeFileSync(pwdFile, password, { mode: 0o600 });

  // Shell script that prints the password; SSH calls this as SSH_ASKPASS
  const scriptFile = path.join(tmpDir, `.autossh-askpass-${id}.sh`);
  fs.writeFileSync(scriptFile, `#!/bin/sh\ncat "${pwdFile}"\n`, { mode: 0o700 });

  return { scriptFile, pwdFile };
}

/**
 * Remove temporary askpass files (called when the process exits).
 */
function cleanupAskpass(scriptFile, pwdFile) {
  if (scriptFile) { try { fs.unlinkSync(scriptFile); } catch (_) {} }
  if (pwdFile)    { try { fs.unlinkSync(pwdFile);    } catch (_) {} }
}

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 820,
    minHeight: 600,
    webPreferences: {
      // Security: no direct Node.js access inside the renderer
      nodeIntegration: false,
      // Security: renderer and preload run in separate JS worlds
      contextIsolation: true,
      // Allow preload to use require('electron') (needed for contextBridge)
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
    // macOS: show traffic-light buttons overlaid on our custom titlebar
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0d1117',
    // Avoid white flash on load
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Show once content is painted to avoid unstyled flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (app.dock) app.dock.show();
  });

  // On macOS: hide to tray instead of quitting when the red ✕ is clicked
  mainWindow.on('close', (event) => {
    if (process.platform === 'darwin') {
      event.preventDefault();
      mainWindow.hide();
      if (app.dock) app.dock.hide();
      updateTray(autosshProcess !== null);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open DevTools in development mode
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

// ─── AutoSSH Process Management ───────────────────────────────────────────────

/**
 * Spawn the autossh process.
 * Command structure: autossh -M 0 -N -L <spec> ... <host>
 *
 * @param {string}   host        - SSH target (e.g. user@jump-host)
 * @param {string[]} tunnels     - Array of "local_port:remote_host:remote_port"
 * @param {string}   autosshPath - Path to the autossh binary
 * @param {string}   [password]  - Optional SSH password (uses SSH_ASKPASS mechanism)
 * @returns {{ success: boolean, command?: string, error?: string }}
 */
function startAutossh(host, tunnels, autosshPath, password) {
  if (autosshProcess) {
    return { success: false, error: 'A tunnel is already running. Stop it first.' };
  }

  // Build argument list
  const args = ['-M', '0', '-N'];
  for (const spec of tunnels) {
    args.push('-L', spec);
  }
  args.push(host);

  const commandPreview = [autosshPath, ...args].join(' ');
  sendLog('info', `Executing: ${commandPreview}`);
  if (password) sendLog('info', 'Password provided — using SSH_ASKPASS mechanism.');

  // ── SSH_ASKPASS setup (password-based auth) ────────────────────────────────
  let askpassScript = null;
  let pwdFile = null;

  if (password) {
    try {
      const helper = createAskpassHelper(password);
      askpassScript = helper.scriptFile;
      pwdFile       = helper.pwdFile;
    } catch (err) {
      return { success: false, error: `Failed to create password helper: ${err.message}` };
    }
  }

  // Build spawn environment
  const spawnEnv = { ...process.env };
  if (askpassScript) {
    spawnEnv.SSH_ASKPASS         = askpassScript;
    // Force SSH to use the askpass program even when no DISPLAY is set (OpenSSH ≥ 8.4)
    spawnEnv.SSH_ASKPASS_REQUIRE = 'force';
    // Older SSH versions require DISPLAY to be set before they invoke SSH_ASKPASS
    if (!spawnEnv.DISPLAY) spawnEnv.DISPLAY = ':0';
  }

  try {
    autosshProcess = spawn(autosshPath, args, {
      env: spawnEnv,
      // stdin: /dev/null — SSH must not try to read the password from the tty
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    autosshProcess.stdout.on('data', (data) => {
      sendLog('stdout', data.toString().trimEnd());
    });

    // autossh typically writes connection status to stderr
    autosshProcess.stderr.on('data', (data) => {
      sendLog('stderr', data.toString().trimEnd());
    });

    autosshProcess.on('error', (err) => {
      autosshProcess = null;
      cleanupAskpass(askpassScript, pwdFile);
      let msg = `Process error: ${err.message}`;
      // Provide a helpful hint when the binary cannot be found
      if (err.code === 'ENOENT') {
        msg += '\n  → autossh not found. Install it (brew install autossh) or provide the full path.';
      }
      sendLog('error', msg);
      sendStatus(false);
    });

    autosshProcess.on('close', (code, signal) => {
      autosshProcess = null;
      cleanupAskpass(askpassScript, pwdFile);
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      sendLog('info', `Process stopped (${reason})`);
      sendStatus(false);
    });

    sendStatus(true);
    return { success: true, command: commandPreview };
  } catch (err) {
    autosshProcess = null;
    cleanupAskpass(askpassScript, pwdFile);
    return { success: false, error: err.message };
  }
}

/**
 * Kill the running autossh process.
 *
 * @param {boolean} [silent=false] - When true, skip the IPC status update
 *                                   (used during app shutdown).
 */
function stopAutossh(silent = false) {
  if (!autosshProcess) return false;

  try {
    autosshProcess.kill('SIGTERM');

    // Escalate to SIGKILL if the process hasn't exited after 2 seconds
    const proc = autosshProcess;
    setTimeout(() => {
      if (proc && !proc.killed) {
        proc.kill('SIGKILL');
      }
    }, 2000);
  } catch (_) {
    // Process may have already exited; ignore
  }

  autosshProcess = null;
  if (!silent) sendStatus(false);
  return true;
}

// ─── IPC Helpers ──────────────────────────────────────────────────────────────

/** Forward a log line to the renderer */
function sendLog(type, message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('tunnel:log', {
    type,
    message,
    timestamp: new Date().toISOString(),
  });
}

/** Notify the renderer of a tunnel status change */
function sendStatus(running) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('tunnel:status', { running });
  // Keep tray in sync whenever status changes
  updateTray(running);
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('tunnel:start', async (_event, { host, tunnels, autosshPath, password }) => {
  // password is an empty string when the field is blank — treat that as "no password"
  return startAutossh(host, tunnels, autosshPath || 'autossh', password || undefined);
});

ipcMain.handle('tunnel:stop', async () => {
  const stopped = stopAutossh();
  if (stopped) {
    sendLog('info', 'Tunnel stopped by user.');
    return { success: true };
  }
  return { success: false, error: 'No tunnel is currently running.' };
});

// Renderer can poll current status on startup
ipcMain.handle('tunnel:status', () => ({
  running: autosshProcess !== null,
}));

ipcMain.handle('config:save', async (_event, { name, config }) => {
  try {
    configManager.saveProfile(name, config);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('config:load', async (_event, { name }) => {
  try {
    const config = configManager.loadProfile(name);
    return { success: true, config };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('config:list', async () => {
  try {
    const profiles = configManager.listProfiles();
    return { success: true, profiles };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('config:delete', async (_event, { name }) => {
  try {
    configManager.deleteProfile(name);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('config:get-last', async () => {
  try {
    const result = configManager.getLastUsed();
    return { success: true, ...result };
  } catch (_) {
    return { success: false };
  }
});

ipcMain.handle('config:set-last', async (_event, { name }) => {
  try {
    configManager.setLastUsed(name);
    return { success: true };
  } catch (_) {
    return { success: false };
  }
});

// ─── App Lifecycle ─────────────────────────────────────────────────────────────

// ─── IPC — Window / App Control (from renderer) ──────────────────────────────

ipcMain.handle('app:show-window', () => { showWindow(); return { success: true }; });
ipcMain.handle('app:quit',        () => { quitApp();    });

// ─── App Lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  const configPath = path.join(app.getPath('userData'), 'autossh-manager-config.json');
  configManager = new ConfigManager(configPath);
  createWindow();
  setupTray();
});

// Never quit when all windows close — keep running in the tray
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') quitApp();
});

// macOS Dock click: show window
app.on('activate', () => showWindow());

// Ensure tunnel is killed on Cmd+Q / app.quit()
app.on('before-quit', () => stopAutossh(true));

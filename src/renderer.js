'use strict';

/**
 * renderer.js — UI logic for AutoSSH Manager
 *
 * Communicates with the main process exclusively through window.tunnelAPI
 * (injected by preload.js via contextBridge).  No direct Node.js APIs are
 * used here — only DOM manipulation and the exposed IPC wrappers.
 */

// ─── DOM References ────────────────────────────────────────────────────────────

const hostInput          = document.getElementById('hostInput');
const passwordInput      = document.getElementById('passwordInput');
const tunnelsInput       = document.getElementById('tunnelsInput');
const autosshPathInput   = document.getElementById('autosshPath');
const autoReconnectCb    = document.getElementById('autoReconnect');
const autoScrollCb       = document.getElementById('autoScroll');

const btnStart           = document.getElementById('btnStart');
const btnStop            = document.getElementById('btnStop');
const btnNewProfile      = document.getElementById('btnNewProfile');
const btnSaveProfile     = document.getElementById('btnSaveProfile');
const btnDeleteProfile   = document.getElementById('btnDeleteProfile');
const btnClearLog        = document.getElementById('btnClearLog');
const btnHideToTray      = document.getElementById('btnHideToTray');
const btnQuit            = document.getElementById('btnQuit');

const profileListEl      = document.getElementById('profileList');
const statusDot          = document.getElementById('statusDot');
const statusText         = document.getElementById('statusText');
const logOutput          = document.getElementById('logOutput');
const commandPreviewEl   = document.getElementById('commandPreview');
const commandTextEl      = document.getElementById('commandText');

// Modal
const saveModal          = document.getElementById('saveModal');
const profileNameInput   = document.getElementById('profileNameInput');
const btnCloseSaveModal  = document.getElementById('btnCloseSaveModal');
const btnCancelSave      = document.getElementById('btnCancelSave');
const btnConfirmSave     = document.getElementById('btnConfirmSave');

// ─── Application State ─────────────────────────────────────────────────────────

/** Whether the tunnel process is currently running */
let isRunning = false;

/** Name of the currently selected profile (null if none) */
let selectedProfile = null;

/** Cached list of saved profile names */
let profiles = [];

/**
 * Saved copy of the last Start arguments, used for auto-reconnect.
 * Set to null when the user explicitly stops the tunnel.
 * @type {{ host: string, tunnelList: string[], autosshPath: string } | null}
 */
let lastStartConfig = null;

/** setTimeout handle for auto-reconnect delay */
let reconnectTimer = null;

// ─── Initialisation ────────────────────────────────────────────────────────────

async function init() {
  // Register persistent IPC listeners
  window.tunnelAPI.onLog(handleLog);
  window.tunnelAPI.onStatus(handleStatusChange);

  // Populate profile sidebar
  await refreshProfiles();

  // Restore last-used profile
  const { success, name, config } = await window.tunnelAPI.getLastUsed();
  if (success && name && config) {
    applyConfig(config);
    setSelectedProfile(name);
    addLog({ type: 'info', message: `Restored last profile: "${name}"` });
  }

  // Sync UI with any tunnel that may already be running (e.g. after a hot-reload)
  const statusRes = await window.tunnelAPI.getTunnelStatus();
  updateUI(statusRes.running);

  // Wire up live command-preview updates
  [hostInput, tunnelsInput, autosshPathInput].forEach((el) =>
    el.addEventListener('input', updateCommandPreview)
  );
  updateCommandPreview();
}

// ─── Profile Management ────────────────────────────────────────────────────────

async function refreshProfiles() {
  const res = await window.tunnelAPI.listProfiles();
  if (res.success) {
    profiles = res.profiles;
    renderProfileList();
  }
}

function renderProfileList() {
  profileListEl.innerHTML = '';
  btnDeleteProfile.disabled = !selectedProfile;

  if (profiles.length === 0) {
    const li = document.createElement('li');
    li.className = 'profile-empty';
    li.textContent = 'No profiles saved';
    profileListEl.appendChild(li);
    return;
  }

  for (const name of profiles) {
    const li = document.createElement('li');
    li.className = 'profile-item' + (name === selectedProfile ? ' active' : '');
    // textContent prevents XSS for untrusted profile names
    li.textContent = name;
    li.title = name;
    li.addEventListener('click', () => loadProfile(name));
    profileListEl.appendChild(li);
  }
}

async function loadProfile(name) {
  const res = await window.tunnelAPI.loadProfile(name);
  if (!res.success) {
    addLog({ type: 'error', message: `Failed to load profile "${name}": ${res.error}` });
    return;
  }
  applyConfig(res.config);
  setSelectedProfile(name);
  await window.tunnelAPI.setLastUsed(name);
  addLog({ type: 'info', message: `Profile "${name}" loaded.` });
}

/** Populate form fields from a config object */
function applyConfig(config) {
  hostInput.value        = config.host        || '';
  tunnelsInput.value     = config.tunnels      || '';
  autosshPathInput.value = config.autosshPath  || 'autossh';
  autoReconnectCb.checked = !!config.autoReconnect;
  updateCommandPreview();
}

/** Return the current form values as a config object */
function getCurrentConfig() {
  return {
    host:          hostInput.value.trim(),
    tunnels:       tunnelsInput.value.trim(),
    autosshPath:   autosshPathInput.value.trim() || 'autossh',
    autoReconnect: autoReconnectCb.checked,
  };
}

/** Mark a profile as selected and update the sidebar */
function setSelectedProfile(name) {
  selectedProfile = name || null;
  btnDeleteProfile.disabled = !selectedProfile;
  renderProfileList();
}

// ─── Start / Stop ──────────────────────────────────────────────────────────────

btnStart.addEventListener('click', async () => {
  const config = getCurrentConfig();

  // Validate before sending to main process
  const errors = validateConfig(config);
  if (errors.length > 0) {
    addLog({
      type: 'error',
      message: 'Validation failed:\n' + errors.map((e) => '  • ' + e).join('\n'),
    });
    return;
  }

  const tunnelList = config.tunnels
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Remember config for auto-reconnect (password included for reconnect attempts)
  lastStartConfig = { host: config.host, tunnelList, autosshPath: config.autosshPath, password: passwordInput.value };

  const res = await window.tunnelAPI.startTunnel({
    host:        config.host,
    tunnels:     tunnelList,
    autosshPath: config.autosshPath,
    password:    passwordInput.value,
  });

  if (!res.success) {
    addLog({ type: 'error', message: `Could not start tunnel: ${res.error}` });
    lastStartConfig = null;
  }
  // Status update arrives via the 'tunnel:status' IPC event
});

btnStop.addEventListener('click', async () => {
  // Prevent auto-reconnect from firing after a deliberate stop
  lastStartConfig = null;
  clearTimeout(reconnectTimer);

  const res = await window.tunnelAPI.stopTunnel();
  if (!res.success) {
    addLog({ type: 'error', message: `Stop failed: ${res.error}` });
  }
});

// ─── Profile UI Events ────────────────────────────────────────────────────────

btnNewProfile.addEventListener('click', () => {
  setSelectedProfile(null);
  hostInput.value        = '';
  tunnelsInput.value     = '';
  autosshPathInput.value = 'autossh';
  autoReconnectCb.checked = false;
  updateCommandPreview();
  hostInput.focus();
});

btnSaveProfile.addEventListener('click', () => {
  profileNameInput.value = selectedProfile || '';
  openModal();
});

btnDeleteProfile.addEventListener('click', async () => {
  if (!selectedProfile) return;
  // Native confirm is acceptable here — it's a simple, infrequent action
  if (!confirm(`Delete profile "${selectedProfile}"?`)) return;

  const res = await window.tunnelAPI.deleteProfile(selectedProfile);
  if (res.success) {
    addLog({ type: 'info', message: `Profile "${selectedProfile}" deleted.` });
    setSelectedProfile(null);
    await refreshProfiles();
  } else {
    addLog({ type: 'error', message: `Delete failed: ${res.error}` });
  }
});

// ─── Modal ────────────────────────────────────────────────────────────────────

function openModal() {
  saveModal.classList.add('open');
  profileNameInput.focus();
  profileNameInput.select();
}

function closeModal() {
  saveModal.classList.remove('open');
  profileNameInput.value = '';
}

btnCloseSaveModal.addEventListener('click', closeModal);
btnCancelSave.addEventListener('click', closeModal);

// Close on backdrop click
saveModal.addEventListener('click', (e) => {
  if (e.target === saveModal) closeModal();
});

// Keyboard shortcuts inside modal
profileNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  btnConfirmSave.click();
  if (e.key === 'Escape') closeModal();
});

btnConfirmSave.addEventListener('click', async () => {
  const name = profileNameInput.value.trim();
  if (!name) {
    profileNameInput.focus();
    return;
  }

  const config = getCurrentConfig();
  const res = await window.tunnelAPI.saveProfile(name, config);
  closeModal();

  if (res.success) {
    setSelectedProfile(name);
    await refreshProfiles();
    await window.tunnelAPI.setLastUsed(name);
    addLog({ type: 'success', message: `Profile "${name}" saved.` });
  } else {
    addLog({ type: 'error', message: `Save failed: ${res.error}` });
  }
});

// ─── Log Output ───────────────────────────────────────────────────────────────

/** Maximum number of log entries to keep in the DOM */
const MAX_LOG_ENTRIES = 1000;

/**
 * Append a log line to the output panel.
 * @param {{ type: string, message: string, timestamp?: string }} data
 */
function addLog({ type, message, timestamp }) {
  // Remove the placeholder text on the first real entry
  const placeholder = logOutput.querySelector('.log-placeholder');
  if (placeholder) placeholder.remove();

  const now = timestamp ? new Date(timestamp) : new Date();
  const timeStr = now.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;

  const timeSpan = document.createElement('span');
  timeSpan.className = 'log-time';
  timeSpan.textContent = timeStr;

  const msgSpan = document.createElement('span');
  msgSpan.className = 'log-msg';
  // textContent prevents XSS from process output
  msgSpan.textContent = message;

  entry.appendChild(timeSpan);
  entry.appendChild(msgSpan);
  logOutput.appendChild(entry);

  // Auto-scroll
  if (autoScrollCb.checked) {
    logOutput.scrollTop = logOutput.scrollHeight;
  }

  // Prune oldest entries to avoid unbounded memory use
  const entries = logOutput.querySelectorAll('.log-entry');
  if (entries.length > MAX_LOG_ENTRIES) {
    entries[0].remove();
  }
}

btnClearLog.addEventListener('click', () => {
  logOutput.innerHTML = '<div class="log-placeholder">Log cleared.</div>';
});

// ─── Tray / App Control ───────────────────────────────────────────────────────

if (btnHideToTray) {
  btnHideToTray.addEventListener('click', () => {
    // Hide the window; the app keeps running in the background via the tray icon
    window.close();
  });
}

if (btnQuit) {
  btnQuit.addEventListener('click', async () => {
    await window.tunnelAPI.quit();
  });
}

// When user clicks "Start Tunnel" from the tray context menu
window.tunnelAPI.onTrayStartRequested(() => {
  if (!isRunning) {
    btnStart.click();
  }
});

// ─── Status & Auto-reconnect ──────────────────────────────────────────────────

/** Called when the main process emits a 'tunnel:status' event */
function handleStatusChange({ running }) {
  updateUI(running);

  if (!running && lastStartConfig && autoReconnectCb.checked) {
    // Tunnel crashed unexpectedly — schedule a restart
    addLog({ type: 'info', message: 'Tunnel exited unexpectedly. Auto-reconnecting in 5 s…' });
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(async () => {
      if (!isRunning && lastStartConfig) {
        addLog({ type: 'info', message: 'Auto-reconnect: restarting tunnel…' });
        const { host, tunnelList, autosshPath, password } = lastStartConfig;
        const res = await window.tunnelAPI.startTunnel({
          host, tunnels: tunnelList, autosshPath, password,
        });
        if (!res.success) {
          addLog({ type: 'error', message: `Auto-reconnect failed: ${res.error}` });
          lastStartConfig = null; // Stop retrying
        }
      }
    }, 5000);
  }
}

/** Called for every log line emitted by the main process */
function handleLog(data) {
  addLog(data);
}

/** Sync all UI controls to the current running state */
function updateUI(running) {
  isRunning = running;

  btnStart.disabled = running;
  btnStop.disabled  = !running;

  // Disable form fields while the tunnel is active (prevent mid-run edits)
  hostInput.disabled        = running;
  passwordInput.disabled    = running;
  tunnelsInput.disabled     = running;
  autosshPathInput.disabled = running;

  statusDot.className  = `status-dot${running ? ' running' : ''}`;
  statusText.textContent = running ? 'Running' : 'Stopped';
  statusText.className  = `status-text${running ? ' running' : ''}`;

  if (!running) clearTimeout(reconnectTimer);
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate a config object before starting the tunnel.
 * @param {{ host: string, tunnels: string }} config
 * @returns {string[]} Array of error messages (empty if valid)
 */
function validateConfig({ host, tunnels }) {
  const errors = [];

  if (!host) {
    errors.push('SSH Host is required');
  }

  const lines = tunnels
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    errors.push('At least one tunnel entry is required');
  } else {
    // Accept:
    //   local_port:remote_host:remote_port
    //   bind_addr:local_port:remote_host:remote_port
    const tunnelRe = /^(\S+:)?\d{1,5}:[^:\s]+:\d{1,5}$/;
    for (const line of lines) {
      if (!tunnelRe.test(line)) {
        errors.push(
          `Invalid tunnel: "${line}" — expected local_port:remote_host:remote_port`
        );
      }
    }
  }

  return errors;
}

// ─── Command Preview ──────────────────────────────────────────────────────────

/** Rebuild and display the autossh command that would be run */
function updateCommandPreview() {
  const host   = hostInput.value.trim();
  const raw    = tunnelsInput.value.trim();
  const binary = autosshPathInput.value.trim() || 'autossh';

  if (!host && !raw) {
    commandPreviewEl.classList.remove('visible');
    return;
  }

  const specs = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const lPart = specs.map((s) => `-L ${s}`).join(' ');
  const cmd   = `${binary} -M 0 -N${lPart ? ' ' + lPart : ''}${host ? ' ' + host : ''}`;

  // textContent prevents XSS from user input being rendered as HTML
  commandTextEl.textContent = cmd;
  commandPreviewEl.classList.add('visible');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

init();

'use strict';

/**
 * configManager.js — Persistent profile storage for AutoSSH Manager
 *
 * Profiles are saved as a JSON file in Electron's userData directory.
 *
 * File structure:
 * {
 *   "lastProfile": "dev",
 *   "profiles": {
 *     "dev": {
 *       "host":          "user@jump-host.example.com",
 *       "tunnels":       "8080:backend:80\n5432:db:5432",
 *       "autosshPath":   "autossh",
 *       "autoReconnect": false
 *     }
 *   }
 * }
 *
 * All methods are synchronous — they are called only from the main process
 * inside ipcMain.handle callbacks (which can be async wrappers), so blocking
 * I/O for a tiny JSON file is perfectly acceptable.
 */

const fs   = require('fs');
const path = require('path');

class ConfigManager {
  /**
   * @param {string} configPath - Absolute path to the JSON config file
   */
  constructor(configPath) {
    this.configPath = configPath;
    this._ensureDir();
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  /** Create the parent directory if it does not yet exist */
  _ensureDir() {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /** Read and parse the config file; return a blank structure on any error */
  _read() {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf8');
      const parsed = JSON.parse(raw);
      // Ensure expected shape
      if (typeof parsed !== 'object' || parsed === null) throw new Error('bad shape');
      if (typeof parsed.profiles !== 'object')            parsed.profiles = {};
      return parsed;
    } catch (_) {
      return { lastProfile: null, profiles: {} };
    }
  }

  /** Serialise and atomically overwrite the config file */
  _write(data) {
    const json = JSON.stringify(data, null, 2);
    // Write to a temp file then rename for atomic replacement
    const tmp = this.configPath + '.tmp';
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, this.configPath);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Persist (create or overwrite) a profile.
   * @param {string} name
   * @param {object} config
   */
  saveProfile(name, config) {
    if (!name || typeof name !== 'string') throw new Error('Profile name is required');
    const data = this._read();
    data.profiles[name] = config;
    this._write(data);
  }

  /**
   * Load an existing profile by name.
   * @param {string} name
   * @returns {object}
   */
  loadProfile(name) {
    const data = this._read();
    const profile = data.profiles[name];
    if (!profile) throw new Error(`Profile "${name}" not found`);
    return profile;
  }

  /**
   * Return an array of all saved profile names.
   * @returns {string[]}
   */
  listProfiles() {
    const data = this._read();
    return Object.keys(data.profiles);
  }

  /**
   * Remove a profile by name.
   * @param {string} name
   */
  deleteProfile(name) {
    const data = this._read();
    if (!data.profiles[name]) throw new Error(`Profile "${name}" not found`);
    delete data.profiles[name];
    if (data.lastProfile === name) data.lastProfile = null;
    this._write(data);
  }

  /**
   * Return the last-used profile name and its config (or nulls if unset).
   * @returns {{ name: string|null, config: object|null }}
   */
  getLastUsed() {
    const data = this._read();
    const name   = data.lastProfile || null;
    const config = name ? (data.profiles[name] || null) : null;
    return { name, config };
  }

  /**
   * Record the name of the most recently used profile.
   * @param {string|null} name
   */
  setLastUsed(name) {
    const data = this._read();
    data.lastProfile = name;
    this._write(data);
  }
}

module.exports = ConfigManager;

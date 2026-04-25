# AutoSSH Manager

A production-ready Electron desktop application for managing AutoSSH tunnels — no CLI required.

![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)
![Electron](https://img.shields.io/badge/electron-33-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Screenshot

> Dark GitHub-style UI with sidebar profiles, live command preview, and real-time log output.

---

## Features

- **Start / Stop** AutoSSH tunnels with one click
- **Multiple `-L` port-forwarding rules** (one per line)
- **Multiple profiles** — save, load, delete named configs (e.g. `dev`, `prod`, `staging`)
- **Auto-reconnect** — automatically restarts the tunnel 5 s after an unexpected crash
- **Live command preview** — shows the exact `autossh` command before you run it
- **Real-time log output** — streams stdout/stderr from the process
- **Remember last profile** — restores your previous session on next launch
- **Configurable binary path** — works even if `autossh` is not on `$PATH`
- **Secure by default** — `nodeIntegration: false`, `contextIsolation: true`, strict CSP

---

## Prerequisites

| Requirement | Install |
|---|---|
| **Node.js** ≥ 18 | [nodejs.org](https://nodejs.org) |
| **autossh** | `brew install autossh` |
| **SSH access** to your jump host | (your existing SSH config / keys) |

---

## Getting Started

```bash
# 1. Clone / enter the project directory
cd autossh-app

# 2. Install dependencies
npm install

# 3. Start the app
npm start
```

To open DevTools automatically during development:

```bash
npm run start:dev
```

---

## Usage

### 1. Fill in Connection Settings

| Field | Example | Description |
|---|---|---|
| **SSH Host** | `user@jump-host.example.com` | The SSH server autossh connects to |
| **Port Tunnels** | `8080:backend:80` | One `local_port:remote_host:remote_port` per line |
| **AutoSSH Binary** | `autossh` or `/usr/local/bin/autossh` | Path to the binary (default: `autossh`) |

**Tunnel format:**

```
local_port:remote_host:remote_port

# Examples
8080:192.168.1.100:80
5432:db-server.internal:5432
6379:redis.internal:6379

# With explicit bind address
127.0.0.1:8080:backend:80
```

### 2. Save a Profile (optional)

Click **Save Profile** in the sidebar footer, enter a name, and click **Save**.  
Profiles are stored locally in the OS `userData` directory as a JSON file.

### 3. Start the Tunnel

Click **Start Tunnel**.  
The status indicator turns green and pulses while the tunnel is active.  
All stdout/stderr from `autossh` streams into the Log Output panel.

### 4. Stop the Tunnel

Click **Stop Tunnel**.  
The process receives `SIGTERM`; if it hasn't exited after 2 s it receives `SIGKILL`.

---

## Auto-Reconnect

Enable the **Restart tunnel on unexpected exit** toggle before starting.  
If the process crashes (non-zero exit or signal), the app waits 5 seconds and automatically restarts it with the same configuration.

> Auto-reconnect is **not** triggered when you click **Stop Tunnel** — only on unexpected exits.

---

## Configuration File

Profiles are persisted to:

```
~/Library/Application Support/AutoSSH Manager/autossh-manager-config.json
```

Example file structure:

```json
{
  "lastProfile": "dev",
  "profiles": {
    "dev": {
      "host": "user@dev-jump.example.com",
      "tunnels": "8080:backend:80\n5432:db:5432",
      "autosshPath": "autossh",
      "autoReconnect": true
    },
    "prod": {
      "host": "user@prod-jump.example.com",
      "tunnels": "8443:internal-api:443",
      "autosshPath": "/usr/local/bin/autossh",
      "autoReconnect": false
    }
  }
}
```

---

## Building for macOS

```bash
# Build universal .dmg + .zip → dist/
npm run build

# Build without packaging (faster, for testing)
npm run pack
```

Output is written to `dist/`.  
The build produces a **universal binary** (Apple Silicon + Intel) by default.

### Optional: App Icon

Place a 512×512 `.icns` file at:

```
assets/icon.icns
```

If omitted, Electron uses its default icon.

---

## Project Structure

```
autossh-app/
├── main.js              # Electron main process — window, autossh spawn, IPC handlers
├── preload.js           # contextBridge — secure renderer ↔ main API surface
├── package.json         # Scripts, deps, electron-builder config
└── src/
    ├── index.html       # UI markup — strict CSP, no inline scripts/styles
    ├── styles.css       # Dark theme (CSS variables, CSS animations)
    ├── renderer.js      # All UI logic — profiles, start/stop, validation, logs
    └── configManager.js # JSON profile persistence (atomic writes)
```

---

## Security Notes

- `nodeIntegration` is **disabled** — the renderer has no direct Node.js access.
- `contextIsolation` is **enabled** — the renderer and preload run in separate JS worlds.
- All IPC channels are whitelisted in `preload.js`; no arbitrary channel access is possible.
- A strict **Content-Security-Policy** header blocks inline scripts, eval, and external resources.
- All process output and user input is written via `textContent` (never `innerHTML`) to prevent XSS.

---

## Scripts Reference

| Command | Description |
|---|---|
| `npm start` | Start the app in production mode |
| `npm run start:dev` | Start with DevTools open |
| `npm run build` | Build macOS DMG + ZIP (universal) |
| `npm run build:mac` | Same as `build` (explicit mac target) |
| `npm run pack` | Build unpacked `.app` only (no installer) |

---

## Troubleshooting

**`autossh: command not found`**  
Install autossh (`brew install autossh`) or set the full binary path in the **AutoSSH Binary** field.

**Tunnel starts but connections fail**  
Check that your SSH key is loaded (`ssh-add -l`) and that the jump host is reachable with plain `ssh`.

**App shows "Stopped" immediately after Start**  
Check the Log Output panel — the error from `autossh` will appear there (wrong host, key issues, port conflicts, etc.).

**`EADDRINUSE` in logs**  
The local port is already in use. Change the local port in your tunnel spec or free the port first.

---

## License

MIT

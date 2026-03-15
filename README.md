# TSwarm


A spatial terminal workspace: an infinite 2D canvas with multiple real shell sessions (PTY) you can spawn, drag, resize, and zoom. Use it like a multi‑terminal cockpit for Claude Code, Codex CLI, Gemini CLI, or any CLI tool you already have installed.

## What You Get
- Infinite 2D canvas with pan + zoom
- Multiple real terminal sessions (PTY), each fully independent
- Double‑click the canvas to spawn a new terminal
- Drag and resize terminals freely
- Close terminals without affecting others
- Sidebar file tree for quick navigation of your repository
- Works on macOS, Windows, and Linux (Tauri)

## One‑Command Install

### macOS / Linux
```bash
curl -fsSL https://raw.githubusercontent.com/Sankalpcreat/TSwarm/main/scripts/install.sh | bash
```

### Windows (PowerShell)
```powershell
iwr -useb https://raw.githubusercontent.com/Sankalpcreat/TSwarm/main/scripts/install.ps1 | iex
```

## Download Without Command (Releases)
1. Go to the GitHub Releases page.
2. Download the installer for your OS:
   - macOS: `.dmg`
   - Windows: `.exe` or `.msi`
   - Linux: `.AppImage`
3. Install and launch.

## Quick Start
1. Launch TSwarm.
2. Double‑click the canvas to spawn a terminal.
3. Type any CLI command you want.
4. Use the sidebar to open a repository path.
5. Spawn more terminals with `+ New Terminal`.
6. Zoom with mouse wheel, pan by dragging the background.

## Using Claude Code / Codex / Gemini CLI
TSwarm runs **real shells**, so any CLI tool available on your system will work.

Examples:
- `claude` (Claude Code CLI)
- `codex` (Codex CLI)
- `gemini` (Gemini CLI)

If a tool works in your normal terminal, it will work here.

## Features (Detailed)
1. Real PTY terminals (not fake renders)
2. Multiple concurrent sessions
3. Infinite canvas + freeform layout
4. Zoom and pan without losing terminal focus
5. Resize terminals without reloading sessions
6. File tree sidebar (lazy-loaded)
7. One‑command install for macOS/Windows/Linux

## Notes
- macOS installs into `/Applications`.
- Linux installs into `~/.local/bin/` (make sure it’s in your PATH).
- Windows uses the standard installer from Releases.
- You need to install any CLI tools (Claude/Codex/Gemini) yourself.

## Development
```bash
npm install
npm run tauri dev
```

## Build
```bash
npm run tauri build
```

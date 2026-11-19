# VANTA Download Manager

**A high-concurrency Windows desktop video, audio, and music workstation built with Rust, Tauri 2, React 19, yt-dlp, spotDL, FFmpeg, and FFprobe.**

[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011%20x64-0078D4?style=flat-square&logo=windows)](#installation)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-24C8DB?style=flat-square&logo=tauri)](#architecture--technology-stack)
[![Rust](https://img.shields.io/badge/Rust-2021%20Edition-DEA584?style=flat-square&logo=rust)](#architecture--technology-stack)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react)](#architecture--technology-stack)
[![Build Workflow](https://github.com/Demonariya/Vanta-Download-Manager/actions/workflows/windows-release.yml/badge.svg)](https://github.com/Demonariya/Vanta-Download-Manager/actions/workflows/windows-release.yml)

---

## Table of Contents

1. [Overview](#overview)
2. [Application Screenshots](#application-screenshots)
3. [Features](#features)
4. [Supported Download Engines](#supported-download-engines)
5. [Architecture & Technology Stack](#architecture--technology-stack)
6. [Installation](#installation)
7. [Building from Source](#building-from-source)
8. [PowerShell Build Instructions](#powershell-build-instructions)
9. [Build Parameters & Output Layout](#build-parameters--output-layout)
10. [Project Structure](#project-structure)
11. [Configuration & Data Locations](#configuration--data-locations)
12. [Troubleshooting](#troubleshooting)
13. [Known Limitations](#known-limitations)
14. [Contributing](#contributing)
15. [License](#license)

---

## Overview

VANTA Download Manager pairs a native **Rust + Tauri 2** backend with a responsive **React 19 + TypeScript + Tailwind CSS** desktop interface to manage video downloads, audio extractions, playlist ingestion, and Spotify metadata resolution from one workspace.

On Windows, VANTA executes external engine subprocesses (`yt-dlp`, `spotdl`, `ffmpeg`, `ffprobe`) hidden with `CREATE_NO_WINDOW`, tracks child process trees safely on cancellation or exit, persists queue and history state in SQLite, and downloads/SHA-256 verifies missing engine binaries on first run so installers remain compact.

---

## Application Screenshots

> *No static PNG screenshots are bundled in this repository.*

The desktop workspace provides:
- **Dashboard & Overview** (`DashboardView`): Live throughput telemetry, queue summary cards, quick URL analysis entry, and active transfer counters.
- **Download Queue & Floating Progress Dock** (`QueueView`, `FloatingProgressDock`): Priority-ordered transfer cards with live speed, downloaded size, ETA, phase indicator, and pause/resume/cancel/retry controls.
- **New Download & URL Inspector** (`NewDownloadModal`): Real-time URL metadata inspection, format/resolution selection, audio format targets, and playlist track selection.
- **Music Library & History** (`MusicLibraryView`, `HistoryView`): Verified audio track metadata (`FLAC`, `MP3`, `M4A`, `OPUS`, `WAV`), album/artist views, and searchable transfer history.
- **Diagnostics & Settings** (`DiagnosticsView`, `SettingsView`): Engine binary discovery, SHA-256 managed engine installer/updater, Netscape cookie validator/tester, concurrency controls, and safe shutdown prompts.

---

## Features

- **Multi-Engine Media & Music Ingestion**
  - Video, playlist, channel, and direct stream analysis via `yt-dlp` with format/resolution (`2160p`/`4K`, `1440p`, `1080p`, `720p`, `480p`, `360p`), subtitle, and thumbnail embedding support.
  - Real Spotify metadata extraction (`src-tauri/src/spotify.rs` & `server/spotify.ts`) supporting tracks, albums, and playlists via Spotify API credentials, web/embed metadata resolution, and oEmbed artwork resolution, paired with `spotDL` audio matching and ID3/artwork tagging.
  - Stream verification and container/codec processing via `FFmpeg` and `FFprobe`.

- **Priority Queue & Process Control**
  - Priority scheduling (`Highest`, `High`, `Normal`, `Low`) and Finite State Machine lifecycle (`Queued -> Extracting -> Downloading -> Processing -> Completed`).
  - Configurable concurrent task limit, per-task/global rate limiting (`--limit-rate`), fragment concurrency (`yt-dlp -N`), exponential-backoff retries, and full pause/resume/cancel/retry/delete actions.
  - Process-tree tracking (`active_processes` and `active_inspections`), cancellation tokens, and safe window-close confirmation (`SafeCloseDialog`) when transfers are active.

- **Cookie Authentication & Diagnostics**
  - Strict Netscape `cookies.txt` validation (`cookies.ts` / `cookies.rs`) with secret-redacted logging (`logging.rs`).
  - Managed storage at `%LOCALAPPDATA%\com.vanta.downloadmanager\cookies.txt`, browser cookie profile detection (`Chrome`, `Edge`, `Firefox`, `Brave`, `Opera`, `Vivaldi`), and live URL authentication testing.
  - Built-in diagnostics runner to check binary paths, versions, and latency, plus one-click managed engine installation and updates.

- **SQLite Persistence & JSON Export/Import**
  - Stores download queue state, task metrics, notifications, and application settings in WAL-mode SQLite (`vanta_native.db` on Windows desktop; `.vanta_data/vanta.db` in Node workstation mode).

---

## Supported Download Engines

| Engine | Role | Packaging & Runtime Discovery | Integrity Verification |
| :--- | :--- | :--- | :--- |
| **yt-dlp** | Primary video, playlist, and HTTP stream extractor & downloader | Side-by-side (`bin/`), managed `%LOCALAPPDATA%\...\engines\bin`, or system `PATH` | SHA-256 verified against upstream `SHA2-256SUMS` |
| **spotDL** | Spotify track/album/playlist audio matching & tagging (`v4.6.0` pinned) | Managed `%LOCALAPPDATA%\...\engines\bin` or system `PATH` | Pinned Windows release SHA-256 verified |
| **FFmpeg & FFprobe** | Container muxing, audio transcoding (`FLAC`/`MP3`/`M4A`/`OPUS`/`WAV`), and stream inspection | Managed compact Windows GPL-shared build or system `PATH` | SHA-256 verified against `BtbN/FFmpeg-Builds` checksums |

VANTA builds **slim installers** by default (no 300+ MiB bundled engine binaries inside the installer). On first launch or from **Diagnostics**, the app automatically downloads, SHA-256 verifies, and installs the required Windows binaries into `%LOCALAPPDATA%\com.vanta.downloadmanager\engines\bin` (while **Portable ZIP** builds also check a local `bin/` folder beside `VANTA.exe`).

---

## Architecture & Technology Stack

- **Desktop Shell & Backend**: Rust (2021 Edition), Tauri 2 (`tauri`, `tauri-plugin-shell`), `tokio`, `rusqlite` (bundled SQLite), `reqwest`, `sha2`, `zip`
- **Frontend**: React 19, TypeScript, Vite 8, Tailwind CSS v4 (`@tailwindcss/vite`), `lucide-react`
- **Web Workstation Server (optional browser/dev mode)**: Express (`server.ts`) + Server-Sent Events + SQLite data persistence (`server/`)
- **CI/CD**: GitHub Actions (`windows-release.yml`) on `windows-latest` with Node.js 24 and `build.ps1`

---

## Installation

### From GitHub Releases (Recommended)

1. Open [Releases](https://github.com/Demonariya/Vanta-Download-Manager/releases) (or download artifacts from a successful **Actions** workflow run).
2. Choose one of the Windows x64 packages:
   - **`*-setup.exe` (NSIS Installer)** — Recommended standard Windows 10/11 installer.
   - **`*.msi` (MSI Installer)** — Windows Installer package for managed or enterprise deployment.
   - **`*-portable.zip` (Portable Archive)** — Extract anywhere and launch `VANTA.exe` (place optional custom engine binaries inside the adjacent `bin/` directory).
3. Verify the downloaded file against `SHA256SUMS.txt`:
   ```powershell
   Get-FileHash .\VANTA-Download-Manager_1.0.0_x64-setup.exe -Algorithm SHA256
   ```
4. Launch VANTA and open **Diagnostics** if prompted to fetch managed engine binaries (`yt-dlp`, `FFmpeg`/`FFprobe`, `spotDL`).

---

## Building from Source

### System Prerequisites (Windows 10 / 11 x64)

- **Windows 10 or Windows 11** (64-bit)
- **PowerShell 7+** recommended (compatible with Windows PowerShell 5.1)
- **Node.js >= 20.19.0** (Node.js 24 LTS recommended; Node 26.x supported) and `npm` — [nodejs.org](https://nodejs.org/)
- **Rust Stable Toolchain** (`x86_64-pc-windows-msvc`) — [rustup.rs](https://rustup.rs/)
- **Visual Studio 2022 Build Tools** with **Desktop development with C++** and the **Windows 10/11 SDK**
- **Microsoft Edge WebView2 Runtime** (pre-installed on modern Windows 10/11)

> For detailed developer setup, lockfile repair, manual clean rebuilds, NSIS/MSI packaging internals, and CI workflow parity, see **[BUILDING.md](./BUILDING.md)**.

---

## PowerShell Build Instructions

`build.ps1` is the single canonical build entrypoint for both local Windows builds and GitHub Actions releases.

### Quick Start

```powershell
# Clone repository
git clone https://github.com/Demonariya/Vanta-Download-Manager.git
cd Vanta-Download-Manager

# Run full Release build (NSIS + MSI + Portable ZIP + SHA256SUMS.txt + build-report.txt)
.\build.ps1
```

### Pre-flight Check (Read-Only Diagnostics Without Modifying Files)

```powershell
.\build.ps1 -Check
```

Validates Node.js/npm/Rust/MSVC/Windows SDK/WebView2/Tauri toolchains, cross-platform `package-lock.json` entries via `npm ci --dry-run --include=optional`, icons, capabilities, TypeScript lint (`npm run lint`), and Cargo formatting/metadata without modifying project files.

---

## Build Parameters & Output Layout

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `-Release` | Switch | Default | Build optimized release binary and installers |
| `-Dev` | Switch | Off | Build debug Tauri binary/bundles (`tauri build --debug`) |
| `-Clean` | Switch | Off | Remove `dist/`, staging folders, and run `cargo clean` before building |
| `-Target` | String | `all` | Package target: `all`, `nsis`, `msi`, or `portable` |
| `-SkipInstall` | Switch | Off | Skip `npm ci --include=optional` when `node_modules/` and Tauri CLI exist |
| `-SkipTests` | Switch | Off | Skip `npm run lint`, `cargo fmt`, and `cargo test` for faster local iteration |
| `-Check` | Switch | Off | Read-only environment, SDK, lockfile, icon, lint, and Cargo metadata checks |
| `-RepairLockfile` | Switch | Off | Regenerate cross-platform `package-lock.json` and verify clean `npm ci --include=optional` |
| `-RustTarget` | String | `x86_64-pc-windows-msvc` | Target Rust triple passed to `rustup` and `tauri build` |
| `-CommandTimeoutSeconds` | Int | `1800` | Process timeout per external step before terminating its process tree |

### Common Examples

```powershell
# Clean production build of every package format
.\build.ps1 -Clean -Release -Target all

# Fast incremental NSIS installer build without reinstalling node_modules
.\build.ps1 -Target nsis -SkipInstall

# Portable standalone ZIP only
.\build.ps1 -Target portable

# MSI package without running unit tests
.\build.ps1 -Target msi -SkipTests

# Explicitly regenerate package-lock.json with full OS/CPU optional dependencies
.\build.ps1 -RepairLockfile
```

### Generated `dist/` Structure

After `build.ps1` finishes, Vite's intermediate web bundle (already embedded into `vanta.exe`) is cleaned from `dist/` and replaced with clean release deliverables:

```text
dist/
├── VANTA Download Manager_1.0.0_x64-setup.exe     # NSIS Setup Installer
├── VANTA Download Manager_1.0.0_x64_en-US.msi     # Windows MSI Installer
├── VANTA-Download-Manager_1.0.0_x64-portable.zip  # Portable ZIP (VANTA.exe + bin/)
├── SHA256SUMS.txt                                  # SHA-256 digests for every package
└── build-report.txt                                # Toolchain versions, binary size & manifest
```

*(Exact NSIS/MSI filenames match Tauri bundler's generated output for `productName` and `version` in `src-tauri/tauri.conf.json`.)*

---

## Project Structure

```text
Vanta-Download-Manager/
├── .github/workflows/
│   └── windows-release.yml       # Automated Windows x64 CI build & GitHub Release workflow
├── build.ps1                     # Canonical PowerShell Windows build & packaging script
├── BUILDING.md                   # Detailed developer build & troubleshooting guide
├── package.json                  # Frontend scripts & dependencies
├── public/                       # Static web icons (favicon.ico, icon.png)
├── server.ts                     # Express + Vite middleware server for browser/workstation mode
├── server/                       # Node backend modules (cookies, db, engineManager, queue, spotify)
├── src/                          # React 19 frontend application
│   ├── App.tsx
│   ├── components/               # Views, modals, progress dock, titlebar, settings
│   ├── services/                 # Desktop/API bridge client
│   ├── types/                    # Shared TypeScript interfaces
│   └── utils/                    # Format/engine parsers, validators, queue helpers & unit tests
└── src-tauri/                    # Native Rust + Tauri 2 desktop backend
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── capabilities/default.json
    ├── icons/                    # Application icons (.ico, .icns, PNG sizes)
    └── src/                      # commands, cookies, engines, logging, models, process, spotify, state
```

---

## Configuration & Data Locations

### Windows Desktop App (`Tauri`)

- **App Data Root**: `%LOCALAPPDATA%\com.vanta.downloadmanager\`
- **SQLite Database**: `%LOCALAPPDATA%\com.vanta.downloadmanager\vanta_native.db`
- **Managed Engines**: `%LOCALAPPDATA%\com.vanta.downloadmanager\engines\bin\` and `manifest.json`
- **Managed Cookies File**: `%LOCALAPPDATA%\com.vanta.downloadmanager\cookies.txt`
- **Rotating Diagnostic Logs**: `%LOCALAPPDATA%\com.vanta.downloadmanager\logs\vanta.log` (secrets redacted automatically)

### Optional Environment Variables (`.env`)

Copy `.env.example` or define optional environment variables when needed:

- `SPOTIFY_CLIENT_ID` / `VANTA_SPOTIFY_CLIENT_ID` & `SPOTIFY_CLIENT_SECRET` / `VANTA_SPOTIFY_CLIENT_SECRET`: Optional Spotify Web API credentials for authenticated metadata lookup (otherwise VANTA uses public embed/page/oEmbed extraction).

### Workstation Server Mode (`npm run dev`)

- Launches Express on port `3000` with Vite middleware (`tsx server.ts`) and stores state in `.vanta_data/vanta.db`.

---

## Troubleshooting

- **Missing MSVC linker (`link.exe not found`)**: Install Visual Studio 2022 Build Tools with the **Desktop development with C++** workload and Windows 10/11 SDK, then restart your PowerShell terminal.
- **Rolldown Windows native binding error during Vite build**: `build.ps1` runs `npm ci --include=optional` and verifies `@rolldown/binding-win32-x64-msvc`. If an interrupted install broke `node_modules`, run `.\build.ps1 -Clean`.
- **Browser Cookie Extraction Fails on Windows Chrome/Edge**: Chromium browsers on Windows lock their SQLite cookie database while open and apply App-Bound Encryption. Export a Netscape `cookies.txt` file and import/paste it in **Settings → Cookies**, or close the browser before testing profile extraction.
- **Missing Engines (`yt-dlp` / `ffmpeg` / `spotdl`)**: Open **Diagnostics → Install / Update Managed Engines** inside VANTA, or place standalone Windows binaries in `%LOCALAPPDATA%\com.vanta.downloadmanager\engines\bin\`.
- **Execution Policy blocks `.\build.ps1`**: Run once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` or invoke via `pwsh -ExecutionPolicy Bypass -File .\build.ps1`.

---

## Known Limitations

- **Windows-First Packaging**: CI workflows and `build.ps1` target Windows 10/11 x64 (`x86_64-pc-windows-msvc`, NSIS, MSI, Portable ZIP). macOS/Linux bundles are not configured in the default release pipeline.
- **Spotify Audio Sourcing**: VANTA resolves genuine Spotify track, album, playlist, and artwork metadata and delegates audio matching to `spotDL`; audio availability depends on matching streams found by `spotDL` rather than direct Spotify DRM decryption.
- **Unsigned Windows Binaries**: Release installers do not include an Authenticode code-signing certificate by default (`certificateThumbprint: null`), so Windows SmartScreen may prompt until signed with a publisher certificate.

---

## Contributing

1. Fork the repository and create a feature branch from `main`.
2. Ensure TypeScript checks (`npm run lint`) and frontend unit tests (`npx tsx --test src/utils/*.test.ts`) pass.
3. On Windows, verify Rust tests and build readiness using `.\build.ps1 -Check` before opening a pull request.
4. Keep changes focused and never commit secrets, `.env` files, or generated `dist/` / `src-tauri/target/` binaries.

---

## License

Some TypeScript modules carry `SPDX-License-Identifier: Apache-2.0` file headers; no standalone root `LICENSE` file is currently committed in the repository. Add a root `LICENSE` file if publishing formal terms for external distribution.

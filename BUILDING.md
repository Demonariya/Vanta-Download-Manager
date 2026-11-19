# Building VANTA Download Manager on Windows

This guide covers everything required to prepare a Windows workstation, validate dependencies, build the native **Rust + Tauri 2** desktop application, package NSIS/MSI/Portable deliverables with `build.ps1`, and reproduce CI releases locally.

---

## 1. Required Toolchains & SDKs

Install the following on **Windows 10 or Windows 11 (64-bit x64)**:

1. **PowerShell 7+** *(recommended)* — [github.com/PowerShell/PowerShell](https://github.com/PowerShell/PowerShell)  
   `build.ps1` also maintains compatibility with Windows PowerShell 5.1.
2. **Node.js 20+ (Node.js 24 LTS recommended)** + `npm` — [nodejs.org](https://nodejs.org/)
3. **Rust Toolchain (`stable-x86_64-pc-windows-msvc`)** — [rustup.rs](https://rustup.rs/)  
   ```powershell
   rustup toolchain install stable-x86_64-pc-windows-msvc
   rustup default stable-x86_64-pc-windows-msvc
   rustup target add x86_64-pc-windows-msvc
   ```
4. **Visual Studio 2022 Build Tools** — [visualstudio.microsoft.com/downloads](https://visualstudio.microsoft.com/downloads/)  
   Enable:
   - **Desktop development with C++**
   - **MSVC v143 - VS 2022 C++ x64/x86 build tools**
   - **Windows 10 SDK** or **Windows 11 SDK**
5. **WebView2 Runtime** (pre-installed on Windows 11 and modern Windows 10).
6. **Git for Windows** *(optional, populates short commit hash in `dist/build-report.txt`)*.

> **Note on NSIS & WiX (MSI):** Tauri CLI downloads/manages NSIS and WiX Toolset binaries automatically during `tauri build` when bundling `nsis` and `msi` targets.

---

## 2. Clean Checkout & First-Time Setup

```powershell
git clone https://github.com/Demonariya/Vanta-Download-Manager.git
cd Vanta-Download-Manager

# Run diagnostics before compiling
.\build.ps1 -Check
```

What `-Check` verifies:
- Repository root discovery (`package.json` & `src-tauri/tauri.conf.json`)
- Node.js (`>= 20`), `npm`, `rustc`, `cargo`, and `rustup` target availability
- Presence of `src-tauri/capabilities/default.json`, all icons configured in `src-tauri/tauri.conf.json`, and `public/favicon.ico` / `public/icon.png`
- Frontend dependencies (`npm ci --include=optional` + Windows `@rolldown/binding-win32-x64-msvc`)
- `npx tauri --version`
- TypeScript check (`npm run lint` -> `tsc --noEmit`)
- Rust verification (`cargo check --manifest-path src-tauri/Cargo.toml --features desktop`)
- Frontend production bundle verification (`npm run build`)

---

## 3. Running `build.ps1`

`build.ps1` executes a deterministic 7-stage pipeline and exits with code `1` immediately if any step fails:

1. **Stage 1:** Toolchain, target triple, Tauri capabilities, icon assets, and optional side-by-side binary checks
2. **Stage 2:** Clean build outputs and `cargo clean` when `-Clean` is passed
3. **Stage 3:** `npm ci --include=optional` (or skip with `-SkipInstall`) and Windows Rolldown native binding check
4. **Stage 4:** TypeScript check (`npm run lint`)
5. **Stage 5:** Rust unit tests (`cargo test --manifest-path src-tauri/Cargo.toml --features desktop`)
6. **Stage 6:** Tauri 2 compile & bundle (`npx tauri build --features desktop --target x86_64-pc-windows-msvc ...`)
7. **Stage 7:** Artifact verification, Portable ZIP packaging, SHA-256 generation (`dist/SHA256SUMS.txt`), and manifest generation (`dist/build-report.txt`)

### Build Commands Reference

```powershell
# Default production release build (NSIS + MSI + Portable ZIP)
.\build.ps1

# Full clean production rebuild from scratch
.\build.ps1 -Clean -Release -Target all

# Debug/development Tauri bundle
.\build.ps1 -Dev -Target nsis

# Build single installer target only
.\build.ps1 -Target nsis
.\build.ps1 -Target msi
.\build.ps1 -Target portable

# Skip npm reinstall and unit tests during rapid local UI iteration
.\build.ps1 -Target nsis -SkipInstall -SkipTests
```

---

## 4. Packaging Details & Frontend Embedding Lifecycle

- `src-tauri/tauri.conf.json` configures `"beforeBuildCommand": "npm run build"` and `"frontendDist": "../dist"`.
- During Stage 6, `build.ps1` removes stale installer archives from `dist/` first so Vite can write the production frontend bundle into `dist/`, which Tauri compiles into `vanta.exe`.
- Once `vanta.exe` and installers finish building in `src-tauri/target/<triple>/<profile>/`, Stage 7 clears Vite's transient static assets out of `dist/` and copies **only verified final release deliverables** into `dist/`:
  - NSIS setup `.exe` from `src-tauri/target/x86_64-pc-windows-msvc/<profile>/bundle/nsis/`
  - Windows `.msi` from `src-tauri/target/x86_64-pc-windows-msvc/<profile>/bundle/msi/`
  - Portable ZIP (`VANTA-Download-Manager_<version>_x64-portable.zip`) containing `VANTA.exe` plus any files present in `src-tauri/bin/` (excluding `.gitkeep`) under `bin/`
  - `dist/SHA256SUMS.txt`
  - `dist/build-report.txt`

### Slim vs. Bundled Engine Mode

- By default, `src-tauri/bin/` only contains `.gitkeep`, producing compact installers (~10–25 MiB rather than 300+ MiB).
- VANTA downloads and SHA-256 verifies `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`, and `spotdl.exe` at runtime into `%LOCALAPPDATA%\com.vanta.downloadmanager\engines\bin\`.
- If you want an offline portable package with pre-staged engines, copy `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`, and `spotdl.exe` into `src-tauri/bin/` before running `.\build.ps1 -Target portable` (do not commit those binaries to Git).

---

## 5. Manual Commands (Without Wrapper Features)

If you want to run individual development or test tasks directly:

```powershell
# Start browser/workstation dev server (Express + Vite on port 3000)
npm run dev

# Start Tauri desktop app in hot-reload dev mode
npm run tauri dev

# Typecheck TypeScript sources
npm run lint

# Run frontend utility unit tests
npx tsx --test src/utils/*.test.ts

# Run Rust backend unit tests directly
cargo test --manifest-path src-tauri/Cargo.toml --features desktop
```

---

## 6. Release Verification Checklist

Before tagging a release (`git tag vX.Y.Z && git push origin vX.Y.Z`):

1. Verify version numbers match in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
2. Run `.\build.ps1 -Clean -Release -Target all`.
3. Inspect `dist/build-report.txt` and verify all target sizes and SHA-256 digests in `dist/SHA256SUMS.txt`:
   ```powershell
   Get-Content .\dist\build-report.txt
   Get-Content .\dist\SHA256SUMS.txt
   ```
4. Launch the generated `*-setup.exe` or `VANTA.exe` from the Portable ZIP on Windows 10/11 and verify:
   - Window opens without console/terminal popups
   - Diagnostics detects or installs managed engines cleanly
   - Sample URL inspection and cookie validation succeed

---

## 7. CI/CD Parity (`windows-release.yml`)

GitHub Actions uses `.github/workflows/windows-release.yml` on `windows-latest`:
- Checks out repo with `actions/checkout@v7`
- Sets up Node.js 24 (`actions/setup-node@v7`) and Rust stable MSVC (`dtolnay/rust-toolchain@stable` + `swatinem/rust-cache@v2`)
- Invokes `.\build.ps1 -Release -Target all` directly — no duplicated build commands in YAML
- Attaches `dist/*-setup.exe`, `dist/*.msi`, `dist/*-portable.zip`, `dist/SHA256SUMS.txt`, and `dist/build-report.txt` to job summary, Actions artifacts (`retention-days: 5`), and GitHub Releases (on `v*` tags or manual dispatch with release enabled).

---

## 8. Common Build Errors & Fixes

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| `Execution of scripts is disabled on this system` | PowerShell execution policy | Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` or `pwsh -ExecutionPolicy Bypass -File .\build.ps1` |
| `linker link.exe not found` | Missing C++ Build Tools or Windows SDK | Install VS 2022 Build Tools ("Desktop development with C++") and restart shell |
| `Cannot find native binding @rolldown/binding-win32-x64-msvc` | Partial/corrupted `node_modules` | Delete `node_modules` or run `.\build.ps1 -Clean` |
| `cargo test` fails locking SQLite or target files | Stale `vanta.exe` process running | Close running `VANTA` / `vanta.exe` instances and retry |
| Build attempted on Linux/macOS | Windows-only Tauri targets require Windows host | Run `.\build.ps1 -Check` for pre-flight checks or trigger `.github/workflows/windows-release.yml` on GitHub Actions |

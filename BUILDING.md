# Building VANTA Download Manager on Windows

This guide covers everything required to prepare a Windows workstation, validate dependencies, build the native **Rust + Tauri 2** desktop application, package NSIS/MSI/Portable deliverables with `build.ps1`, and reproduce CI releases locally.

---

## 1. Required Toolchains & SDKs

Install the following on **Windows 10 or Windows 11 (64-bit x64)**:

1. **PowerShell 7+** *(recommended)* — [github.com/PowerShell/PowerShell](https://github.com/PowerShell/PowerShell)  
   `build.ps1` also maintains compatibility with Windows PowerShell 5.1.
2. **Node.js >= 20.19.0 (Node.js 24 LTS recommended; Node 26.x supported)** + `npm` — [nodejs.org](https://nodejs.org/)
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

## 2. Clean Checkout & Pre-Flight Checks

```powershell
git clone https://github.com/Demonariya/Vanta-Download-Manager.git
cd Vanta-Download-Manager

# Read-only diagnostics before compiling
.\build.ps1 -Check
```

What `-Check` verifies (strictly read-only — never edits lockfiles or writes `dist/`):
- Repository root discovery (`package.json` & `src-tauri/tauri.conf.json`)
- Node.js (`>= 20.19.0`), `npm`, `rustc`, `cargo`, and `rustup` target (`x86_64-pc-windows-msvc`)
- Windows host checks: Visual Studio C++ Build Tools (`vswhere.exe` / `cl.exe`), Windows 10/11 SDK registry (`KitsRoot10`), and WebView2 Runtime registry check
- Absence of duplicate lockfiles (`bun.lock`, `yarn.lock`, `pnpm-lock.yaml`)
- Cross-platform `package-lock.json` integrity (`win32-x64-msvc`, `win32-arm64-msvc`, `darwin-*`, `linux-*` optional dependencies) and `npm ci --dry-run --include=optional`
- Presence and JSON validity of `src-tauri/capabilities/default.json`, configured icons in `src-tauri/icons/`, and `public/favicon.ico` / `public/icon.png`
- TypeScript check (`npm run lint`) and Tauri CLI version when `node_modules/` is present
- `cargo fmt --check` and `cargo metadata --no-deps`

---

## 3. Lockfile Repair vs. Ordinary Production Builds

| Aspect | Ordinary Build (`.\build.ps1`) | Lockfile Repair (`.\build.ps1 -RepairLockfile`) |
| :--- | :--- | :--- |
| **Dependency install** | Runs `npm ci --include=optional` strictly | Backs up `package-lock.json`, clears `node_modules/`, regenerates `package-lock.json` |
| **Mutates `package-lock.json`?** | **Never** (fails on `EUSAGE` mismatch) | **Yes** (intended when dependencies change or platform optional entries are missing) |
| **Verification** | Fails fast on mismatch | Validates cross-platform keys + runs clean `npm ci --include=optional`, `npm ls --depth=0`, `npm run lint`, `npm run build` |
| **Allowed in CI?** | **Yes** | **No** (CI must fail loudly if `package-lock.json` is out of sync) |

### Clean Installation Procedure (Manual Verification)

```powershell
Remove-Item node_modules -Recurse -Force -ErrorAction SilentlyContinue
npm ci --include=optional
npm ls --depth=0
npm run build
```

### Repairing `package-lock.json` Safely

If you ever add/update npm dependencies or encounter `EUSAGE` (`Missing: ... from lock file`), never delete `package-lock.json` ad-hoc inside a dirty `node_modules/`. Run:

```powershell
.\build.ps1 -RepairLockfile
```

Wait for all verification steps (`npm ci --include=optional`, `npm ls --depth=0`, `npm run lint`, `npm run build`) to pass, review `git diff package-lock.json`, and commit the updated lockfile.

---

## 4. Running `build.ps1`

`build.ps1` executes a deterministic 7-stage pipeline with deadlock-free async stdout/stderr capture, configurable timeouts (`-CommandTimeoutSeconds`), failure log saving (`last-build-failure.log`), and non-zero exit codes on any failure:

1. **Stage 1:** Toolchain, MSVC/Windows SDK/WebView2 checks, Rust target, lockfile validation, capabilities & icon assets
2. **Stage 2:** Clean build outputs and `cargo clean` when `-Clean` is passed (preserves source files, lockfiles, icons, and `.vanta_data`)
3. **Stage 3:** Deterministic `npm ci --include=optional` + `npm ls --depth=0` + Tauri CLI check
4. **Stage 4:** TypeScript typecheck (`npm run lint`)
5. **Stage 5:** Rust format check (`cargo fmt --check`) & unit tests (`cargo test --manifest-path src-tauri/Cargo.toml --features desktop`)
6. **Stage 6:** Tauri 2 compile & bundle (`npx tauri build --features desktop --target x86_64-pc-windows-msvc ...`)
7. **Stage 7:** Artifact verification, Portable ZIP packaging, `dist/SHA256SUMS.txt`, and `dist/build-report.txt`

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

# Skip npm reinstall and tests during rapid local UI iteration
.\build.ps1 -Target nsis -SkipInstall -SkipTests
```

---

## 5. Packaging Details, Build Report & Artifact Verification

- `src-tauri/tauri.conf.json` configures `"beforeBuildCommand": "npm run build"` and `"frontendDist": "../dist"`.
- During Stage 6, `build.ps1` removes stale installer archives from `dist/` first so Vite can write the production frontend bundle into `dist/`, which Tauri embeds into `vanta.exe`.
- Once `vanta.exe` and installers finish building in `src-tauri/target/<triple>/<profile>/`, Stage 7 clears Vite's transient static assets out of `dist/` and copies **only verified final release deliverables** into `dist/`:
  - NSIS setup `.exe` from `src-tauri/target/x86_64-pc-windows-msvc/<profile>/bundle/nsis/`
  - Windows `.msi` from `src-tauri/target/x86_64-pc-windows-msvc/<profile>/bundle/msi/`
  - Portable ZIP (`VANTA-Download-Manager_<version>_x64-portable.zip`) containing `VANTA.exe` plus any files present in `src-tauri/bin/` (excluding `.gitkeep`) under `bin/`
  - `dist/SHA256SUMS.txt`
  - `dist/build-report.txt` (records version, build date, build mode, bundle target, Rust triple, git commit, status, duration, Node/npm/rustc/cargo versions, `vanta.exe` size, and every artifact's exact byte size and SHA-256 hash)

### Slim vs. Bundled Engine Mode

- By default, `src-tauri/bin/` only contains `.gitkeep`, producing compact installers.
- VANTA downloads and SHA-256 verifies `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`, and `spotdl.exe` at runtime into `%LOCALAPPDATA%\com.vanta.downloadmanager\engines\bin\`.
- For an offline portable ZIP with pre-staged engines, copy Windows engine binaries into `src-tauri/bin/` before running `.\build.ps1 -Target portable` (do not commit those binaries to Git).

---

## 6. Release Verification Checklist

Before tagging a release (`git tag vX.Y.Z && git push origin vX.Y.Z`):

1. Verify version numbers match in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
2. Run `.\build.ps1 -Clean -Release -Target all`.
3. Verify artifact digests against `dist/SHA256SUMS.txt` and review `dist/build-report.txt`:
   ```powershell
   Get-Content .\dist\build-report.txt
   Get-Content .\dist\SHA256SUMS.txt
   Get-FileHash .\dist\*.exe, .\dist\*.msi, .\dist\*.zip -Algorithm SHA256
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
- Runs `.\build.ps1 -Check` then `.\build.ps1 -Release -Target all` — zero duplicated build commands in YAML and zero silent lockfile mutation
- Publishes `dist/build-report.txt` (or `dist/last-build-failure.log` on failure) to the job summary
- Attaches `dist/*-setup.exe`, `dist/*.msi`, `dist/*-portable.zip`, `dist/SHA256SUMS.txt`, and `dist/build-report.txt` to Actions artifacts (`retention-days: 5`) and GitHub Releases (`v*` tags or manual dispatch)

---

## 8. Common Build Errors & Fixes

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| `npm ci` fails with `EUSAGE` / `Missing: ... from lock file` | `package-lock.json` missing cross-platform optional deps or out of sync | Run `.\build.ps1 -RepairLockfile` and commit `package-lock.json` |
| `Execution of scripts is disabled on this system` | PowerShell execution policy | Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` or `pwsh -ExecutionPolicy Bypass -File .\build.ps1` |
| `linker link.exe not found` | Missing C++ Build Tools or Windows SDK | Install VS 2022 Build Tools ("Desktop development with C++") and restart shell |
| `Cannot find native binding @rolldown/binding-win32-x64-msvc` | Partial/corrupted `node_modules` | Delete `node_modules` and run `npm ci --include=optional` (or `.\build.ps1 -Clean`) |
| `cargo test` fails locking SQLite or target files | Stale `vanta.exe` process running | Close running `VANTA` / `vanta.exe` instances and retry |
| Build attempted on Linux/macOS | Windows-only Tauri targets require Windows host | Run `.\build.ps1 -Check` for pre-flight validation or trigger `.github/workflows/windows-release.yml` on GitHub Actions |

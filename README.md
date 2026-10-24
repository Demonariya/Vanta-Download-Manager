# VANTA Download Manager

**VANTA** is a desktop video and music workstation powered by **Rust, Tauri 2, yt-dlp, spotDL, FFmpeg, and FFprobe**. It provides a high-concurrency download queue, process telemetry, real-time speed monitoring, floating progress notifications, and format conversions for video and audio.

---

## Key Features

1. **Multi-Engine Ingestion**:
   - **yt-dlp (2026.10.21)**: Single videos, playlists, channels, direct HTTP/HTTPS media streams, resolution selection (4K/2160p, 1440p, 1080p, 720p, 480p, 360p), subtitle and thumbnail embedding.
   - **spotDL (4.5.2)**: Dedicated music ingestion pipeline supporting Spotify tracks, albums, and playlists, automatic ID3 tagging, high-res artwork, and lyrics.
   - **FFmpeg & FFprobe (4.4.2)**: Lossless audio extraction (FLAC), MP3 (up to 320kbps), M4A (AAC), OPUS, WAV, container multiplexing (MP4, MKV, WebM), and stream verification.
   - **Python (3.11)**: Managed runtime environment for Python-based extractors.

2. **High-Concurrency Queue Architecture**:
   - Priority-based scheduling (`Highest`, `High`, `Normal`, `Low`).
   - Finite State Machine: `Queued → Extracting → Downloading → Processing → Completed`.
   - Dynamic concurrency safeguards (configurable from 1 to 10 concurrent tasks).
   - Global and per-task bandwidth rate limiter (`--limit-rate` in KB/s).
   - Fragment concurrency (`yt-dlp -N`).
   - Automatic exponential backoff retry for recoverable network errors.
   - Global Pause All / Resume All and per-task Pause, Resume, Cancel, Retry, and Delete.

3. **Floating Progress Surfaces & Notifications**:
   - Minimizable floating transference widget displaying live bandwidth, completion percentage, phase, and ETA.
   - Notification flyout logging task lifecycle events (completed, retrying, failed).

4. **Persistence & Data Architecture**:
   - Built-in SQLite database storing download queue, task progress, and settings.
   - Survives application restarts with automatic resumption of pending tasks.
   - Export/import history as JSON.

5. **Engine Health & Diagnostics Suite**:
   - Live discovery of installed system binaries with path and version detection.
   - "Run Diagnostics Test" button executing test calls and reporting latency.

---

## Architecture & Technology Stack

- **Native Backend**: Rust Stable + Tauri 2 (`src-tauri/`)
- **Frontend**: React 19 + TypeScript + Vite + Tailwind CSS (`src/`)
- **Full-Stack Runtime**: Express server with Server-Sent Events (`server.ts`) and Vite middleware mounting for workstation environments.
- **Engines**: `yt-dlp`, `spotDL`, `ffmpeg`, `ffprobe`
- **Database**: SQLite (`.vanta_data/vanta.db`)

---

## Windows 10 & 11 Build Instructions

### Prerequisites
- Windows 10 or 11 (64-bit)
- [Rust](https://rustup.rs/) (stable-x86_64-pc-windows-msvc)
- [Node.js](https://nodejs.org/) v20+ or v22+
- Microsoft C++ Build Tools (with Windows 10/11 SDK)
- WebView2 Runtime (pre-installed on Windows 10/11)

### Building the Windows Installer & Executable

```powershell
# 1. Install Node dependencies
npm install

# 2. Build the production React frontend
npm run build

# 3. Download the standalone Windows binaries for external engines into src-tauri/bin:
New-Item -ItemType Directory -Force -Path src-tauri/bin
Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -OutFile "src-tauri/bin/yt-dlp.exe"
# Extract ffmpeg.exe and ffprobe.exe into src-tauri/bin/

# 4. Compile the Tauri 2 release binary and installer
npm run tauri build
```

This generates:
- Standalone Release Executable: `src-tauri/target/release/vanta.exe`
- Windows NSIS Installer: `src-tauri/target/release/bundle/nsis/VANTA Download Manager_1.0.0_x64-setup.exe`
- Windows MSI Package: `src-tauri/target/release/bundle/msi/VANTA Download Manager_1.0.0_x64.msi`

## ساخت فایل نصبی ویندوز در گیت‌هاب (GitHub Actions Installer Build)

یک ورک‌فلو کامل و خودکار در مسیر `.github/workflows/windows-release.yml` آماده شده است که تمامی مراحل دانلود موتورهای `yt-dlp` و `FFmpeg`، کامپایل Rust با کامپایلر MSVC و ایجاد فایل‌های نصبی را روی سرورهای ویندوزی گیت‌هاب انجام می‌دهد.

### نحوه دریافت فایل نصبی از گیت‌هاب:

#### روش اول: اجرای دستی با یک کلیک (بدون نیاز به نصب ابزار)
1. به مخزن پروژه در **GitHub** بروید.
2. روی تب **Actions** در بالای صفحه کلیک کنید.
3. در ستون سمت چپ، ورک‌فلو **Build & Release Windows Desktop App** را انتخاب کنید.
4. روی دکمه **Run workflow** کلیک کرده و دکمه سبز رنگ را بزنید.
5. پس از پایان بیلد (حدود ۳ تا ۵ دقیقه)، وارد همان اجرا شوید:
   - در بخش **Artifacts** در پایین صفحه، بسته زیپ حاوی فایل نصبی با نام `VANTA-Windows-Installer-x64` برای دانلود مستقیم قرار دارد.
   - این بسته شامل فایل نصبی `VANTA Download Manager_x64-setup.exe` (NSIS Installer)، بسته سازمانی `MSI` و نسخه پرتابل مستقل (`Portable.zip`) است.

#### روش دوم: ایجاد خودکار با انتشار نسخه (Release Tag)
هر زمان که یک Tag جدید (مثلاً `v1.0.0`) روی ریپازیتوری Push شود، گیت‌هاب به صورت خودکار یک **GitHub Release** ایجاد کرده و فایل‌های `.exe`، `.msi` و کدهای اعتبارسنجی `SHA256SUMS.txt` را به آن متصل می‌کند.

---

## Windows 10 & 11 Local Build Instructions

### Prerequisites
- Windows 10 or 11 (64-bit)
- [Rust](https://rustup.rs/) (stable-x86_64-pc-windows-msvc)
- [Node.js](https://nodejs.org/) v20+ or v22+
- Microsoft C++ Build Tools (with Windows 10/11 SDK)
- WebView2 Runtime (pre-installed on Windows 10/11)

### Building Locally

```powershell
# 1. Install Node dependencies
npm install

# 2. Build the production React frontend
npm run build

# 3. Download the standalone Windows binaries for external engines into src-tauri/bin:
New-Item -ItemType Directory -Force -Path src-tauri/bin
Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -OutFile "src-tauri/bin/yt-dlp.exe"

# 4. Compile the Tauri 2 release binary and installer
npm run tauri build
```

This generates:
- **Windows NSIS Setup Installer**: `src-tauri/target/release/bundle/nsis/VANTA Download Manager_1.0.0_x64-setup.exe`
- **Windows MSI Package**: `src-tauri/target/release/bundle/msi/VANTA Download Manager_1.0.0_x64.msi`
- **Standalone Release Executable**: `src-tauri/target/release/vanta.exe`

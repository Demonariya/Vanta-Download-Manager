# VANTA Download Manager — Browser Extension

A Manifest V3 extension for Chrome and Microsoft Edge. It detects directly exposed media URLs, offers a compact Media Radar popup, adds VANTA actions to the browser context menu, and forwards selected URLs to the VANTA desktop application.

## Install

1. Start VANTA Desktop.
2. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose this `browser-extension` folder.
5. Pin **VANTA Download Manager** to the browser toolbar.

## Features

- Branded VANTA toolbar icon and popup.
- Desktop bridge online/offline indicator.
- Current page title and URL with one-click handoff.
- Media Radar for exposed HTML5 video/audio sources, Open Graph media, direct audio/video links, and large page images.
- All / Video / Audio / Links filters.
- Per-item Add action that opens VANTA's existing Download File Info dialog.
- Context-menu actions for links, media, images, and the current page.
- Dynamic HTML5 media detection and a VANTA hover action on supported video/audio elements.
- Clear success/error feedback; no silent downloads.

## Security and limitations

The extension sends only HTTP(S) URLs to the loopback desktop bridge at `127.0.0.1:47831`. It does not decrypt DRM, bypass paywalls, extract authentication tokens, or claim support for opaque `blob:`/MSE streams. Website and browser restrictions may prevent inspection. The desktop application remains responsible for extraction and downloading.

The extension does not request broad access to every website through `host_permissions`; its content script runs on HTTP(S) pages and browser APIs still restrict protected/internal pages.

## Troubleshooting

- **VANTA Offline:** start the desktop application, then reopen the popup.
- **No media found:** the page may not expose direct URLs. Try sending the page URL to VANTA's yt-dlp inspector.
- **Hover button missing:** check that the page exposes a regular HTML5 video/audio element and reload the tab after reloading the extension.
- **Extension update not visible:** use the Reload button on the browser's extensions page.

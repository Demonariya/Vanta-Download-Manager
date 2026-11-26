# VANTA Download Manager — Browser Extension

Manifest V3 extension for Chrome and Microsoft Edge. It detects supported video/audio sources and sends the selected page or media URL to the VANTA desktop application.

## Install manually

1. Start VANTA Desktop.
2. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the `browser-extension` directory.
5. Pin **VANTA Download Manager** to the browser toolbar.

The NSIS installer also places a ready-to-load `Extension` folder beside the installed application and uninstaller.

## Features

- Uses the same icon asset as the VANTA desktop application.
- VANTA desktop bridge online/offline indicator.
- YouTube page recognition with a video thumbnail preview; the YouTube page URL is handed to VANTA/yt-dlp.
- HTML5 video/audio source detection, Open Graph media, and direct audio/video file links.
- Video thumbnails are previews only; images are not offered as downloadable candidates.
- All / Video / Audio / Links filters.
- Context-menu actions for links, video/audio elements, and the current page. No image download action.
- Per-item Add action opens VANTA's Download File Info dialog; no silent downloads.

## Security and limitations

The extension sends only HTTP(S) URLs to the loopback desktop bridge at `127.0.0.1:47831`. It does not decrypt DRM, bypass paywalls, extract authentication tokens, or claim support for opaque `blob:`/MSE streams. Website and browser restrictions may prevent inspection. The desktop application remains responsible for extraction and downloading.

## Troubleshooting

- **VANTA Offline:** start the desktop application, then reopen the popup.
- **No media found:** the page may not expose direct URLs. Try sending the page URL to VANTA's yt-dlp inspector.
- **Extension update not visible:** use Reload on the browser extensions page, or reload the unpacked extension after updating the folder.

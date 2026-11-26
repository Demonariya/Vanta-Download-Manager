# VANTA Browser Integration (Chrome / Edge)

This is a Manifest V3 extension for sending ordinary web links and directly exposed media URLs to VANTA Download Manager.

## Requirements

- VANTA desktop application must be running. The local browser bridge starts with the desktop runtime on `127.0.0.1:47831`.
- Chrome 116+ or a recent Microsoft Edge release with Manifest V3 support.
- The extension works with regular HTTP(S) pages. Browser-internal pages (`chrome://`, `edge://`), browser store pages and restricted tabs cannot be inspected.

## Install in Chrome

1. Start VANTA.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Select this repository's `browser-extension` folder.
6. Pin **VANTA Browser Integration** from the Extensions menu.

## Install in Microsoft Edge

1. Start VANTA.
2. Open `edge://extensions`.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Select this repository's `browser-extension` folder.

## Use

- Click the VANTA extension icon to inspect the current page.
- Use **Send page to VANTA** to send the current page URL.
- The popup scans visible DOM media elements, Open Graph media URLs and direct links ending in common audio/video file extensions.
- Use **Send** beside a detected candidate to hand it to VANTA.
- Right-click a direct media element, link, or page and choose the corresponding **Download with VANTA** context-menu action.
- VANTA opens its existing **Download File Info** dialog with the received URL prefilled. Review format, destination and other options before starting.

## Supported detection boundaries

The extension only reports URLs that the page exposes directly through ordinary DOM properties and metadata. It does not:
- decrypt or bypass DRM;
- extract protected streams, encrypted media segments, or authentication tokens;
- promise detection of MSE/blob URLs, opaque player internals, or every HLS/DASH manifest;
- bypass website access controls, paywalls, or browser restrictions.

If a site exposes only a `blob:` URL or a protected player, the extension will not pretend that URL is a downloadable source. A website-specific extractor may still be supported by VANTA's existing yt-dlp integration when the user submits the page URL.

## Local bridge

The desktop runtime listens only on IPv4 loopback `127.0.0.1:47831`. The bridge accepts `POST /download` only when the request has a `chrome-extension://` Origin and contains a valid HTTP(S) URL. It emits a typed Tauri event to the desktop UI; the frontend opens the existing download inspection dialog. It does not start a download silently.

The extension requests only `activeTab`, `scripting`, `contextMenus`, and access to the local bridge. It does not request broad access to all websites in the manifest.

## Troubleshooting

- **VANTA offline:** launch the desktop app first, then reopen the popup.
- **No candidates:** the page may not expose direct media URLs. Try submitting the page URL to VANTA's existing media inspector.
- **Restricted page:** browser internal pages and some protected pages prohibit script inspection.
- **Extension changes not visible:** open the browser extensions page and press **Reload** on VANTA Browser Integration.

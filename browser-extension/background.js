const BRIDGE = 'http://127.0.0.1:47831/download';
const MENU_IDS = ['vanta-link', 'vanta-media', 'vanta-page', 'vanta-all-links'];

async function sendToVanta(rawUrl, title = '', source = 'context-menu') {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return false;

  const response = await fetch(BRIDGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: parsed.href, title, source })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || 'VANTA is not running or the browser bridge is unavailable.');
  return true;
}

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'vanta-link', title: 'Download link with VANTA', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'vanta-media', title: 'Download media with VANTA', contexts: ['video', 'audio'] });
    chrome.contextMenus.create({ id: 'vanta-page', title: 'Send current page to VANTA', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'vanta-all-links', title: 'Scan page for downloadable media', contexts: ['page'] });
  });
}
chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'vanta-all-links') {
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'VANTA_SCAN_AND_OPEN' }).catch(() => {});
    return;
  }
  const rawUrl = info.linkUrl || info.srcUrl || (info.menuItemId === 'vanta-page' ? tab?.url : '');
  if (!rawUrl) return;
  try {
    const sent = await sendToVanta(rawUrl, tab?.title || '', 'context-menu');
    if (sent && tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'VANTA_SENT' }).catch(() => {});
  } catch (error) {
    console.warn('[VANTA] Browser bridge:', error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'VANTA_SEND') return;
  sendToVanta(message.url, message.title, message.source || 'extension-popup')
    .then((sent) => sendResponse({ ok: sent }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
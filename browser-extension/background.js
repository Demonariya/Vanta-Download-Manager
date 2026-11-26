const BRIDGE = 'http://127.0.0.1:47831/download';

async function sendToVanta(url, title = '', source = 'context-menu') {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('This item is not a downloadable web URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('Only HTTP(S) links can be sent to VANTA.');
  const response = await fetch(BRIDGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, title, source })
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
  const url = info.linkUrl || (info.menuItemId === 'vanta-media' ? info.srcUrl : '') || (info.menuItemId === 'vanta-page' ? tab?.url : '');
  if (!url || !/^https?:\/\//i.test(url)) { console.info('[VANTA] Ignored non-web or protected media URL.'); return; }
  try {
    await sendToVanta(url, tab?.title || '', 'context-menu');
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'VANTA_SENT' }).catch(() => {});
  } catch (error) {
    console.warn('[VANTA] Browser bridge:', error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'VANTA_SEND') return;
  sendToVanta(message.url, message.title, message.source || 'extension-popup')
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
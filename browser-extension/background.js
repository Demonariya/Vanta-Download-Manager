const BRIDGE = 'http://127.0.0.1:47831/download';

async function sendToVanta(url, title = '', source = 'context-menu') {
  if (!/^https?:\\/\\//i.test(url || '')) throw new Error('Only HTTP(S) links can be sent to VANTA.');
  const response = await fetch(BRIDGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, title, source })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || 'VANTA is not running or the browser bridge is unavailable.');
  return true;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'vanta-link', title: 'Download link with VANTA', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'vanta-media', title: 'Download media with VANTA', contexts: ['video', 'audio'] });
    chrome.contextMenus.create({ id: 'vanta-page', title: 'Send page to VANTA', contexts: ['page'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.linkUrl || info.srcUrl || (info.menuItemId === 'vanta-page' ? tab?.url : '');
  if (!url) return;
  try {
    await sendToVanta(url, tab?.title || '', 'context-menu');
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'VANTA_SENT' }).catch(() => {});
  } catch (error) {
    console.warn('[VANTA] Browser bridge:', error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'VANTA_SEND') return;
  sendToVanta(message.url, message.title, 'extension-popup')
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
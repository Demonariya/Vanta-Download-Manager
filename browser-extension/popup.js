const $ = (id) => document.getElementById(id);
let activeTab = null;
let candidates = [];

function setNotice(message, type = '') {
  const node = $('notice');
  node.textContent = message;
  node.className = `notice visible ${type}`;
}
function setBridgeStatus(online) {
  $('status').textContent = online ? 'VANTA online' : 'VANTA offline';
  $('status').className = `status ${online ? 'online' : 'offline'}`;
}
async function checkBridge() {
  try {
    const response = await fetch('http://127.0.0.1:47831/health', { method: 'GET' });
    setBridgeStatus(response.ok);
  } catch { setBridgeStatus(false); }
}
async function scanPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;
  $('page-title').textContent = tab?.title || 'Untitled page';
  $('page-url').textContent = tab?.url || '';
  $('send-page').disabled = !/^https?:/i.test(tab?.url || '');
  $('candidates').innerHTML = '<div class="empty">Scanning current page…</div>';
  if (!tab?.id || !/^https?:/i.test(tab.url || '')) {
    candidates = [];
    renderCandidates();
    return;
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const found = new Map();
        const add = (url, label, kind) => {
          if (!url || !/^https?:/i.test(url)) return;
          try {
            const absolute = new URL(url, location.href).href;
            if (!found.has(absolute)) found.set(absolute, { url: absolute, label: label || absolute.split('/').pop() || 'Media resource', kind });
          } catch {}
        };
        document.querySelectorAll('video,audio').forEach((el) => {
          add(el.currentSrc || el.src, el.getAttribute('aria-label') || el.getAttribute('title') || el.tagName.toLowerCase(), el.tagName.toLowerCase());
          el.querySelectorAll('source').forEach((s) => add(s.src, s.type || 'Media source', el.tagName.toLowerCase()));
        });
        document.querySelectorAll('meta[property="og:video"],meta[property="og:audio"],meta[name="twitter:player:stream"]').forEach((el) => add(el.content, el.getAttribute('property') || 'Page media', 'media'));
        document.querySelectorAll('a[href]').forEach((a) => {
          if (/\\.(mp4|m4v|webm|mov|mp3|m4a|aac|flac|wav|ogg|opus)(?:$|[?#])/i.test(a.href)) add(a.href, a.textContent.trim() || a.href.split('/').pop(), 'direct link');
        });
        return Array.from(found.values()).slice(0, 30);
      }
    });
    candidates = results?.[0]?.result || [];
  } catch (error) {
    candidates = [];
    setNotice('This page does not allow inspection, or the browser restricted access to it.', 'error');
  }
  renderCandidates();
}
function renderCandidates() {
  $('count').textContent = String(candidates.length);
  const root = $('candidates');
  root.replaceChildren();
  if (!candidates.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No direct media URLs found. DRM streams and protected manifests are not extracted.';
    root.append(empty);
    return;
  }
  for (const item of candidates) {
    const row = document.createElement('div'); row.className = 'candidate';
    const info = document.createElement('div'); info.className = 'candidate-info';
    const name = document.createElement('div'); name.className = 'candidate-name'; name.textContent = item.label;
    const url = document.createElement('div'); url.className = 'candidate-url'; url.textContent = item.url;
    info.append(name, url);
    const button = document.createElement('button'); button.textContent = 'Send';
    button.addEventListener('click', () => send(item.url, item.label));
    row.append(info, button); root.append(row);
  }
}
async function send(url, title) {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'VANTA_SEND', url, title });
    if (!result?.ok) throw new Error(result?.error || 'Could not reach VANTA.');
    setNotice('Sent to VANTA. Review the download details before starting.', 'success');
  } catch (error) { setNotice(error.message || 'VANTA is unavailable.', 'error'); }
}
$('send-page').addEventListener('click', () => send(activeTab.url, activeTab.title));
$('rescan').addEventListener('click', scanPage);
checkBridge();
scanPage();
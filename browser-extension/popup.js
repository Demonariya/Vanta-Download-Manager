const $ = (id) => document.getElementById(id);
let activeTab = null;
let candidates = [];
let activeFilter = 'all';

function setNotice(message, type = '') {
  const node = $('notice'); node.textContent = message; node.className = `notice visible ${type}`;
}
function setBridgeStatus(online) {
  $('status').innerHTML = online ? '<i></i> VANTA Connected' : '<i></i> VANTA Offline';
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
    candidates = []; renderCandidates(); return;
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const found = new Map();
        const add = (raw, label, kind, thumbnail = '') => {
          if (!raw) return;
          try {
            const url = new URL(raw, location.href).href;
            if (!/^https?:/i.test(url) || found.has(url)) return;
            found.set(url, { url, label: label || url.split('/').pop() || 'Media resource', kind, thumbnail });
          } catch {}
        };
        document.querySelectorAll('video,audio').forEach((el) => {
          const kind = el.tagName.toLowerCase();
          add(el.currentSrc || el.src, el.getAttribute('aria-label') || el.getAttribute('title') || document.title || kind, kind, el.poster || document.querySelector('meta[property=\"og:image\"]')?.content || '');
          el.querySelectorAll('source').forEach((s) => add(s.src, s.type || 'Media source', kind));
        });
        document.querySelectorAll('meta[property="og:video"],meta[property="og:audio"],meta[name="twitter:player:stream"]').forEach((el) => add(el.content, el.getAttribute('property') || 'Page media', el.getAttribute('property')?.includes('video') ? 'video' : 'audio'));
        document.querySelectorAll('a[href]').forEach((a) => {
          if (/\.(mp4|m4v|webm|mov|mp3|m4a|aac|flac|wav|ogg|opus)(?:$|[?#])/i.test(a.href)) add(a.href, a.textContent.trim() || a.href.split('/').pop(), 'direct link');
        });
        const youtubeId = location.hostname.endsWith('youtube.com') ? new URL(location.href).searchParams.get('v') : location.hostname === 'youtu.be' ? location.pathname.slice(1) : null;
        if (youtubeId && /^[a-zA-Z0-9_-]{11}$/.test(youtubeId)) {
          const thumbnail = document.querySelector('meta[property="og:image"]')?.content || `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;
          const title = document.querySelector('meta[property="og:title"]')?.content || document.title;
          add(location.href, title, 'video', thumbnail);
        }
        if (!found.size) {
          const video = document.querySelector('video');
          if (video) add(location.href, document.title, 'video', video.poster || document.querySelector('meta[property="og:image"]')?.content || '');
        }
        return Array.from(found.values()).slice(0, 50);
      }
    });
    candidates = results?.[0]?.result || [];
  } catch (error) {
    candidates = [];
    setNotice('This page does not allow inspection, or the browser restricted access.', 'error');
  }
  renderCandidates();
}
function renderCandidates() {
  $('count').textContent = `${candidates.length} found`;
  const visible = candidates.filter((item) => activeFilter === 'all' || item.kind === activeFilter || (activeFilter === 'direct link' && item.kind === 'direct link'));
  const root = $('candidates'); root.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    empty.textContent = candidates.length ? 'No items in this filter.' : 'No direct media URLs found. Protected DRM and opaque player streams are not extracted.';
    root.append(empty); return;
  }
  for (const item of visible) {
    const row = document.createElement('div'); row.className = 'candidate';
    const kind = document.createElement('div'); kind.className = 'kind';
    kind.textContent = item.kind === 'video' ? '▶' : item.kind === 'audio' ? '♫' : '↗';
    const info = document.createElement('div'); info.className = 'candidate-info';\n    if (item.thumbnail) { const thumb = document.createElement('img'); thumb.className = 'candidate-thumb'; thumb.src = item.thumbnail; thumb.alt = ''; thumb.loading = 'lazy'; thumb.referrerPolicy = 'no-referrer'; row.append(thumb); }
    const name = document.createElement('div'); name.className = 'candidate-name'; name.textContent = item.label;
    const meta = document.createElement('div'); meta.className = 'candidate-url';
    try { meta.textContent = item.kind === 'video' ? 'Video · ' + new URL(item.url).hostname : new URL(item.url).hostname; } catch { meta.textContent = item.kind; }
    info.append(name, meta);
    const button = document.createElement('button'); button.textContent = 'Add';
    button.addEventListener('click', () => send(item.url, item.label));
    row.append(kind, info, button); root.append(row);
  }
}
async function send(url, title) {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'VANTA_SEND', url, title, source: 'extension-popup' });
    if (!result?.ok) throw new Error(result?.error || 'Could not reach VANTA.');
    setNotice('Sent to VANTA. Review Download File Info before starting.', 'success');
  } catch (error) { setNotice(error.message || 'VANTA is unavailable.', 'error'); }
}
$('send-page').addEventListener('click', () => send(activeTab.url, activeTab.title));
$('rescan').addEventListener('click', scanPage);
document.querySelectorAll('.filter').forEach((button) => button.addEventListener('click', () => {
  activeFilter = button.dataset.filter;
  document.querySelectorAll('.filter').forEach((item) => item.classList.toggle('active', item === button));
  renderCandidates();
}));
checkBridge(); scanPage();
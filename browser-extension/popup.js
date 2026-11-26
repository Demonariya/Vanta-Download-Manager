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

function getYouTubeId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0] || null;
    if (!/(^|\.)youtube\.com$/i.test(url.hostname)) return null;
    if (url.pathname === '/watch') return url.searchParams.get('v');
    const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/);
    return match?.[1] || null;
  } catch { return null; }
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

  const youtubeId = getYouTubeId(tab.url);
  if (youtubeId) {
    const thumbnail = `https://i.ytimg.com/vi/${encodeURIComponent(youtubeId)}/hqdefault.jpg`;
    candidates = [{
      url: tab.url, label: tab.title || 'YouTube video', kind: 'video',
      thumbnail, host: 'YouTube', source: 'youtube-page'
    }];
    renderCandidates();
    return;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const found = new Map();
        const add = (raw, label, kind, thumbnail = '') => {
          if (!raw) return;
          try {
            const parsed = new URL(raw, location.href);
            if (!['http:', 'https:'].includes(parsed.protocol) || found.has(parsed.href)) return;
            found.set(parsed.href, {
              url: parsed.href,
              label: label || parsed.pathname.split('/').pop() || 'Media resource',
              kind,
              thumbnail: thumbnail && /^https?:/i.test(thumbnail) ? thumbnail : '',
              host: parsed.hostname,
              sourceType: 'media'
            });
          } catch {}
        };
        const ogTitle = document.querySelector('meta[property="og:title"]')?.content || document.title;
        const ogImage = document.querySelector('meta[property="og:image"]')?.content || '';
        document.querySelectorAll('video,audio').forEach((el) => {
          const kind = el.tagName.toLowerCase();
          const poster = el.tagName === 'VIDEO' ? (el.poster || ogImage) : '';
          add(el.currentSrc || el.src, el.getAttribute('aria-label') || el.getAttribute('title') || ogTitle || kind, kind, poster);
          el.querySelectorAll('source').forEach((source) => add(source.src, source.type || kind + ' source', kind, poster));
        });
        document.querySelectorAll('meta[property="og:video"],meta[property="og:audio"],meta[name="twitter:player:stream"]').forEach((meta) => {
          const kind = meta.getAttribute('property')?.includes('audio') ? 'audio' : 'video';
          add(meta.content, ogTitle || 'Page media', kind, ogImage);
        });
        document.querySelectorAll('a[href]').forEach((anchor) => {
          if (/\.(mp4|m4v|webm|mov|mp3|m4a|aac|flac|wav|ogg|opus)(?:$|[?#])/i.test(anchor.href)) {
            const kind = /\.(mp3|m4a|aac|flac|wav|ogg|opus)(?:$|[?#])/i.test(anchor.href) ? 'audio' : 'video';
            add(anchor.href, anchor.textContent.trim() || anchor.href.split('/').pop(), kind, '');
            const item = found.get(new URL(anchor.href, location.href).href);
            if (item) item.sourceType = 'direct';
          }
        });
        if (!found.size && document.querySelector('video')) {
          const video = document.querySelector('video');
          add(location.href, ogTitle || 'Video page', 'video', video.poster || ogImage);
        }
        return Array.from(found.values()).slice(0, 30);
      }
    });
    candidates = results?.[0]?.result || [];
  } catch {
    candidates = [];
    setNotice('This page does not allow inspection, or the browser restricted access.', 'error');
  }
  renderCandidates();
}

function renderCandidates() {
  $('count').textContent = `${candidates.length} found`;
  const visible = candidates.filter((item) => activeFilter === 'all' || item.kind === activeFilter || (activeFilter === 'links' && item.sourceType === 'direct'));
  const root = $('candidates'); root.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    empty.textContent = candidates.length ? 'No media in this filter.' : 'No supported video or audio links found. Images are preview thumbnails only; DRM and protected streams are not extracted.';
    root.append(empty); return;
  }
  for (const item of visible) {
    const row = document.createElement('div'); row.className = 'candidate';
    if (item.thumbnail) {
      const thumb = document.createElement('img');
      thumb.className = 'candidate-thumb'; thumb.src = item.thumbnail; thumb.alt = ''; thumb.loading = 'lazy';
      thumb.onerror = () => thumb.remove();
      row.append(thumb);
    } else {
      const kind = document.createElement('div'); kind.className = 'kind';
      kind.textContent = item.kind === 'video' ? '▶' : '♫';
      row.append(kind);
    }
    const info = document.createElement('div'); info.className = 'candidate-info';
    const name = document.createElement('div'); name.className = 'candidate-name'; name.textContent = item.label;
    const source = document.createElement('div'); source.className = 'candidate-url'; source.textContent = item.host || new URL(item.url).hostname;
    info.append(name, source);
    const button = document.createElement('button'); button.textContent = 'Add';
    button.addEventListener('click', () => send(item.url, item.label));
    row.append(info, button); root.append(row);
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
(() => {
  if (window.__vantaContentLoaded) return;
  window.__vantaContentLoaded = true;
  const MEDIA_SELECTOR = 'video,audio';
  const seen = new WeakSet();
  let enabled = true;

  const send = (url, title, source = 'hover-button') => chrome.runtime.sendMessage({ type: 'VANTA_SEND', url, title, source })
    .then((result) => {
      const toast = document.createElement('div');
      toast.textContent = result?.ok ? 'Sent to VANTA — review the download in the desktop app.' : (result?.error || 'VANTA is unavailable.');
      Object.assign(toast.style, {
        position: 'fixed', zIndex: '2147483647', right: '18px', bottom: '18px',
        maxWidth: '340px', padding: '12px 15px', borderRadius: '10px',
        background: '#15182a', color: '#f5f6ff', border: '1px solid #7560e8',
        boxShadow: '0 12px 40px #0008', font: '12px Segoe UI, sans-serif'
      });
      document.documentElement.append(toast);
      setTimeout(() => toast.remove(), 3200);
    }).catch(() => {});

  function decorate(media) {
    if (seen.has(media)) return;
    seen.add(media);
    media.addEventListener('mouseenter', () => {
      if (!enabled || media.dataset.vantaButton === '1') return;
      const url = media.currentSrc || media.src || media.querySelector('source')?.src;
      if (!url || !/^https?:/i.test(url)) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '↓ VANTA';
      button.dataset.vantaOverlay = '1';
      Object.assign(button.style, {
        position: 'absolute', zIndex: '2147483646', top: '12px', right: '12px',
        padding: '8px 12px', border: '1px solid #9c8bff', borderRadius: '8px',
        background: '#17152eeF', color: '#fff', font: '600 12px Segoe UI, sans-serif',
        cursor: 'pointer', boxShadow: '0 4px 18px #0008'
      });
      const parent = media.parentElement;
      if (!parent) return;
      const position = getComputedStyle(parent).position;
      if (position === 'static') parent.dataset.vantaPosition = parent.style.position;
      if (position === 'static') parent.style.position = 'relative';
      parent.append(button);
      media.dataset.vantaButton = '1';
      button.addEventListener('click', (event) => {
        event.preventDefault(); event.stopPropagation();
        send(url, media.getAttribute('title') || document.title);
        button.remove();
        delete media.dataset.vantaButton;
      });
      const cleanup = () => {
        if (!button.matches(':hover')) {
          button.remove();
          delete media.dataset.vantaButton;
          media.removeEventListener('mouseleave', cleanup);
        }
      };
      media.addEventListener('mouseleave', cleanup);
    });
  }

  function scan(root = document) {
    root.querySelectorAll?.(MEDIA_SELECTOR).forEach(decorate);
  }
  scan();
  const observer = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.matches?.(MEDIA_SELECTOR)) decorate(node);
        scan(node);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'VANTA_SCAN_AND_OPEN') {
      scan();
      const urls = [...document.querySelectorAll(MEDIA_SELECTOR)].map((el) => el.currentSrc || el.src)
        .filter((url) => /^https?:/i.test(url || '')).slice(0, 20);
      if (urls.length) send(urls[0], document.title, 'context-menu-scan');
    }
  });
})();
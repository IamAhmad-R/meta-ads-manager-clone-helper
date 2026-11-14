// Injects the helper as an overlay sidebar on Ads Manager. Everything lives in
// a shadow root so Facebook's stylesheet cannot reach it and vice versa.

const HOST_ID = 'amh-open-sidebar-host';

function getHost() {
  return document.getElementById(HOST_ID);
}

function createHost() {
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all: initial; position: fixed; top: 0; right: 0; z-index: 2147483647;';

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .panel {
      position: relative;
      width: min(500px, 100vw);
      height: 100vh;
      background: #f0f2ff;
      box-shadow: -6px 0 24px rgba(0, 0, 0, 0.25);
      overflow: hidden;
    }
    iframe { width: 100%; height: 100%; border: 0; display: block; }
    .close {
      position: absolute;
      top: 10px;
      right: 10px;
      z-index: 2;
      width: 28px;
      height: 28px;
      border: 0;
      border-radius: 50%;
      background: #dd4254;
      color: #fff;
      font: 20px/1 system-ui, sans-serif;
      cursor: pointer;
    }
  `;

  const panel = document.createElement('div');
  panel.className = 'panel';

  const close = document.createElement('button');
  close.className = 'close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Close helper');
  close.textContent = '×';
  close.addEventListener('click', () => hideSidebar());

  const frame = document.createElement('iframe');
  frame.src = chrome.runtime.getURL('ui/popup.html?mode=sidebar');
  frame.title = 'Ads Manager Helper';

  panel.append(frame, close);
  shadow.append(style, panel);
  return host;
}

function showSidebar() {
  let host = getHost();
  if (!host) {
    host = createHost();
    (document.body || document.documentElement).appendChild(host);
  }
  host.style.display = 'block';
  chrome.storage.sync.set({ sidebarVisible: true });
}

function hideSidebar() {
  const host = getHost();
  if (host) host.style.display = 'none';
  chrome.storage.sync.set({ sidebarVisible: false });
}

function toggleSidebar() {
  const host = getHost();
  if (!host || host.style.display === 'none') showSidebar();
  else hideSidebar();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === 'toggleSidebar') {
    toggleSidebar();
    sendResponse({ ok: true });
    return true;
  }
  if (message?.action === 'closeSidebar') {
    hideSidebar();
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.sidebarMode && changes.sidebarMode.newValue === false) hideSidebar();
  if (changes.sidebarVisible) {
    if (changes.sidebarVisible.newValue) showSidebar();
    else hideSidebar();
  }
});

async function restore() {
  const { sidebarMode, sidebarVisible } = await chrome.storage.sync.get({
    sidebarMode: true,
    sidebarVisible: false,
  });
  if (sidebarMode && sidebarVisible) showSidebar();
}

restore();

// Runs in an extension offscreen document. The sidebar iframe is embedded in
// adsmanager.facebook.com, whose Permissions-Policy blocks the async Clipboard
// API for cross-origin frames; an offscreen document is not embedded, so a
// copy here always works.

async function writeClipboard(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
  document.body.appendChild(area);
  area.focus();
  area.select();

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();

  if (!ok) {
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = false;
    }
  }
  return ok;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen' || message?.type !== 'copy') return false;
  writeClipboard(String(message.text ?? ''))
    .then((ok) => sendResponse({ ok }))
    .catch(() => sendResponse({ ok: false }));
  return true;
});

import { setToken, tokenFromUrl, hasToken, fetchPreviews, fetchAdNames, fetchAd, listAdsets } from './lib/api.js';
import { turnOffEnhancements as removeEnhancements } from './features/enhancements.js';
import { convertCarousels as convertCarouselBatch, duplicateAds as duplicateAdBatch } from './features/duplicate.js';
import { getSyncSettings } from './config.js';

// ---------------------------------------------------------------------------
// Token capture
//
// Ads Manager authenticates its own Graph calls with a token in the request
// URL. Observing the outgoing request is enough to reuse that session; the
// token is never written to disk (session storage only) and is dropped when
// the browser session ends.
// ---------------------------------------------------------------------------

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!details.url.includes('access_token=')) return;
    const token = tokenFromUrl(details.url);
    if (token) setToken(token);
  },
  { urls: ['https://*.facebook.com/*', 'https://graph.facebook.com/*'] },
);

// ---------------------------------------------------------------------------
// Popup vs sidebar
// ---------------------------------------------------------------------------

async function applyActionMode() {
  const { sidebarMode } = await getSyncSettings();
  await chrome.action.setPopup({ popup: sidebarMode ? '' : 'ui/popup.html' });
}

chrome.runtime.onInstalled.addListener(applyActionMode);
chrome.runtime.onStartup.addListener(applyActionMode);
applyActionMode();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.sidebarMode) applyActionMode();
});

chrome.action.onClicked.addListener(async (tab) => {
  const { sidebarMode } = await getSyncSettings();
  if (!sidebarMode || !tab.id) return;
  if (!tab.url?.includes('facebook.com')) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'toggleSidebar' });
  } catch {
    // Page is not an Ads Manager tab or the content script is not there yet.
  }
});

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

function progress(message, current, total) {
  chrome.runtime.sendMessage({ action: 'progress', message, current, total }).catch(() => {});
}

let offscreenCreation = null;

/**
 * Copies text from an extension offscreen document. The sidebar iframe lives
 * inside adsmanager.facebook.com, whose Permissions-Policy blocks the async
 * Clipboard API for embedded cross-origin frames.
 */
async function copyViaOffscreen(text) {
  if (!chrome.offscreen) return false;
  try {
    if (!(await chrome.offscreen.hasDocument())) {
      if (!offscreenCreation) {
        offscreenCreation = chrome.offscreen
          .createDocument({
            url: 'offscreen.html',
            reasons: ['CLIPBOARD'],
            justification: 'Copy preview CSV and post IDs to the clipboard',
          })
          .finally(() => {
            offscreenCreation = null;
          });
      }
      await offscreenCreation;
    }
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'copy',
      text,
    });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

async function askSkip(adId, reason) {
  try {
    const answer = await chrome.runtime.sendMessage({ action: 'askSkip', adId, reason });
    return answer?.skip !== false;
  } catch {
    return true; // popup closed: skip the ad instead of stalling the batch
  }
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

const handlers = {
  async ping() {
    return { ok: true, hasToken: await hasToken() };
  },

  async tokenStatus() {
    return { hasToken: await hasToken() };
  },

  async adNames({ adIds }) {
    return fetchAdNames(adIds);
  },

  async previews({ adIds }) {
    return fetchPreviews(adIds);
  },

  async accountId({ adIds }) {
    if (!adIds?.length) throw new Error('No ad selected.');
    const ad = await fetchAd(adIds[0]);
    return ad.account_id;
  },

  async copyToClipboard({ text }) {
    return copyViaOffscreen(String(text ?? ''));
  },

  async adsets({ accountId, after, statuses }) {
    return listAdsets(accountId, { after, statuses });
  },

  async turnOffEnhancements({ adIds }) {
    return removeEnhancements(adIds, (current, total) =>
      progress(`Removing creative enhancements — ad ${current} of ${total}`, current, total),
    );
  },

  async convertCarousels({ adIds, placements }) {
    return convertCarouselBatch(
      adIds,
      placements,
      (current, total) => progress(`Converting carousel ${current} of ${total}`, current, total),
      askSkip,
    );
  },

  async duplicateAds({ sourceAdIds, adsetIds }) {
    return duplicateAdBatch(sourceAdIds, adsetIds, (done, total) =>
      progress(`Duplicating ad ${done} of ${total}`, done, total),
    );
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.action];
  if (!handler) return false;

  handler(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

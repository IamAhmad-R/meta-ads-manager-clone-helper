import { shortPostId } from './adIds.js';

export function toCsv(rows, columns) {
  const escape = (value) => {
    const text = value == null ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const header = columns.map((column) => escape(column.label)).join(',');
  const body = rows.map((row) => columns.map((column) => escape(column.get(row))).join(','));
  return [header, ...body].join('\r\n');
}

export const PREVIEW_COLUMNS = [
  { label: 'Ad ID', get: (row) => row.adId },
  { label: 'Ad name', get: (row) => row.name },
  { label: 'Ad set', get: (row) => row.adset?.name },
  { label: 'Campaign', get: (row) => row.campaign?.name },
  { label: 'Preview link', get: (row) => row.preview_shareable_link },
  { label: 'Post ID', get: (row) => shortPostId(row.creative?.effective_object_story_id ?? row.creative?.object_story_id) },
  { label: 'Instagram permalink', get: (row) => row.creative?.instagram_permalink_url },
];

export function downloadCsv(filename, csv) {
  const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text) {
  // The sidebar iframe is embedded in adsmanager.facebook.com, whose
  // Permissions-Policy blocks the async Clipboard API for cross-origin frames.
  // The offscreen document copies outside that policy.
  try {
    const response = await chrome.runtime.sendMessage({ action: 'copyToClipboard', text });
    if (response?.ok && response.result) return true;
  } catch {
    // Background unavailable; fall through.
  }

  // A top-level extension page (normal popup, options) may use the async API.
  if (window.top === window) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path.
    }
  }

  const area = document.createElement('textarea');
  area.value = text;
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  return ok;
}

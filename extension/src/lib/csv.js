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

function legacyCopy(text) {
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
  return ok;
}

export async function copyText(text) {
  // In the sidebar the helper runs in an iframe inside adsmanager.facebook.com.
  // That page's Permissions-Policy blocks the async Clipboard API for
  // cross-origin frames, so use the legacy command, which is not covered by it.
  if (window.top !== window) return legacyCopy(text);

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return legacyCopy(text);
  }
}

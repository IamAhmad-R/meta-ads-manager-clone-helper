// Reads the ad selection out of an Ads Manager URL.

export function parseAdIdsFromUrl(url) {
  if (!url || typeof url !== 'string') return { adIds: [], isHash: false };
  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) return { adIds: [], isHash: false };

  let params;
  try {
    params = new URLSearchParams(url.slice(queryIndex + 1));
  } catch {
    return { adIds: [], isHash: false, error: 'This URL could not be read.' };
  }

  let raw = params.get('selected_ad_ids');
  if (!raw) {
    for (const [key, value] of params.entries()) {
      if (key === '$selected_ad_ids' || key === 'selected_ad_ids') {
        raw = value;
        break;
      }
    }
  }
  if (!raw || !raw.trim()) return { adIds: [], isHash: false };

  const trimmed = raw.trim();
  // Meta sometimes collapses a large selection into a 32-char hex hash. The
  // individual IDs cannot be recovered from it.
  const isHash =
    !trimmed.includes(',') &&
    !/^\d+$/.test(trimmed) &&
    /^[a-f0-9]+$/i.test(trimmed) &&
    trimmed.length >= 16;
  if (isHash) return { adIds: [], isHash: true, hash: trimmed };

  const adIds = [...new Set(trimmed.split(',').map((id) => id.trim()).filter(Boolean))];
  return { adIds, isHash: false };
}

export function parseManualIds(text) {
  return [
    ...new Set(
      String(text)
        .split(/[\s,;]+/)
        .map((value) => value.trim())
        .filter((value) => /^\d{5,}$/.test(value)),
    ),
  ];
}

/**
 * Post ids arrive as `<page id>_<post id>` from `object_story_id` /
 * `effective_object_story_id`. Ads Manager's "Use existing post" field expects
 * the trailing numeric part.
 */
export function shortPostId(value) {
  const text = String(value ?? '').trim();
  const index = text.lastIndexOf('_');
  return index === -1 ? text : text.slice(index + 1);
}

import { API_VERSIONS, GRAPH, CREATIVE_FIELDS, PREVIEW_FIELDS, getSessionValue, setSessionValue, clearSessionValue } from '../config.js';
import { ApiError, parseGraphError, describeGraphError, isRetryable, isVersionError } from './errors.js';

const TOKEN_KEY = 'fbAccessToken';
const VERSION_KEY = 'graphApiVersion';
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [2000, 4000];

let memoToken = null;

export async function getToken() {
  if (memoToken) return memoToken;
  const stored = await getSessionValue(TOKEN_KEY);
  if (!stored) {
    throw new ApiError('No Ads Manager session found. Open adsmanager.facebook.com, then click refresh in the helper.', {
      friendly: true,
    });
  }
  memoToken = stored;
  return memoToken;
}

export async function setToken(token) {
  if (memoToken === token) return;
  memoToken = token;
  await setSessionValue(TOKEN_KEY, token);
}

export async function clearToken() {
  memoToken = null;
  await clearSessionValue(TOKEN_KEY);
}

export async function hasToken() {
  if (memoToken) return true;
  return Boolean(await getSessionValue(TOKEN_KEY));
}

export function tokenFromUrl(url) {
  const match = String(url || '').match(/[?&]access_token=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function cachedVersion() {
  const bag = await chrome.storage.local.get(VERSION_KEY);
  return bag[VERSION_KEY] || null;
}

async function rememberVersion(version) {
  await chrome.storage.local.set({ [VERSION_KEY]: version });
}

async function request(version, endpoint, method, body) {
  const token = await getToken();
  const url = `${GRAPH}/${version}/${endpoint}`;
  const init = {
    method,
    headers: { Authorization: `Bearer ${token}` },
  };
  if (body != null && method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw new ApiError('Network request failed. Check your connection and retry.', { retryable: true, friendly: true });
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || (payload && payload.error)) {
    const parsed = parseGraphError(payload?.error);
    const friendlyText = describeGraphError(parsed, { clearToken });
    throw new ApiError(friendlyText || `Graph API error: ${parsed?.message || response.statusText}`, {
      code: parsed?.code,
      subcode: parsed?.subcode,
      retryable: isRetryable(parsed),
      friendly: Boolean(friendlyText),
    });
  }
  return payload;
}

async function requestWithRetry(version, endpoint, method, body) {
  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await request(version, endpoint, method, body);
    } catch (error) {
      lastError = error;
      if (!(error instanceof ApiError) || !error.retryable || attempt === MAX_ATTEMPTS - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt] ?? 4000));
    }
  }
  throw lastError;
}

/**
 * Calls the Graph API, falling back through supported versions when Meta
 * retires the one that worked before.
 */
export async function call(endpoint, { method = 'GET', body = null, retry = true } = {}) {
  const cached = await cachedVersion();
  const versions = cached ? [cached, ...API_VERSIONS.filter((v) => v !== cached)] : API_VERSIONS;

  let lastError;
  for (const version of versions) {
    try {
      const result = retry
        ? await requestWithRetry(version, endpoint, method, body)
        : await request(version, endpoint, method, body);
      if (cached !== version) await rememberVersion(version);
      return result;
    } catch (error) {
      lastError = error;
      if (!(error instanceof ApiError) || !isVersionError(error.message)) throw error;
    }
  }
  throw lastError ?? new ApiError('All Graph API versions failed.');
}

export async function fetchAd(adId) {
  const fields = [
    'status',
    'name',
    'id',
    'tracking_specs',
    'account_id',
    `creative{${CREATIVE_FIELDS}}`,
  ].join(',');
  return call(`${adId}?fields=${fields}`);
}

export async function fetchCreative(adId) {
  const ad = await call(`${adId}?fields=id,account_id,name,creative{${CREATIVE_FIELDS}}`);
  if (!ad?.creative) throw new ApiError(`Ad ${adId} has no creative to read.`, { friendly: true });
  return { adId, name: ad.name, creative: ad.creative };
}

export async function createCreative(accountId, payload) {
  const result = await call(`act_${accountId}/adcreatives`, { method: 'POST', body: payload, retry: false });
  if (!result?.id) throw new ApiError('Meta did not return a creative id.');
  return result.id;
}

export async function setAdCreative(adId, creativeId) {
  const result = await call(adId, { method: 'POST', body: { creative: { creative_id: creativeId } } });
  if (!result?.success) throw new ApiError(`Updating ad ${adId} failed: ${JSON.stringify(result)}`);
}

const STATE_FIELDS = 'degrees_of_freedom_spec,destination_spec,creative_sourcing_spec';

/**
 * Reads a creative back and compares it with the keys we asked Meta to opt out.
 * A key counts as off only when it is present and `OPT_OUT`: Meta can silently
 * drop a feature spec, which would otherwise look like "nothing to report".
 */
export async function fetchCreativeState(creativeId, expectedKeys = []) {
  const data = await call(`${creativeId}?fields=${STATE_FIELDS}`);
  const spec = data?.degrees_of_freedom_spec?.creative_features_spec ?? {};
  const notOff = expectedKeys.filter((key) => spec[key]?.enroll_status !== 'OPT_OUT');
  const destinationOn = [];

  const destination = data?.destination_spec ?? {};
  if (destination.website?.optimization?.status === 'OPT_IN') {
    destinationOn.push('destination:optimize_website_destination');
  }
  if (destination.native_commerce_experience?.product_browsing?.enroll_status === 'OPT_IN') {
    destinationOn.push('destination:product_browsing');
  }
  if (data?.creative_sourcing_spec?.associated_product_set_id) {
    destinationOn.push('sourcing:associated_product_set_id');
  }

  return { notOff, destinationOn, specPresent: Object.keys(spec).length };
}

export async function fetchPreviews(adIds) {
  const chunkSize = 50;
  const rows = [];
  for (let i = 0; i < adIds.length; i += chunkSize) {
    const chunk = adIds.slice(i, i + chunkSize);
    const data = await call(`?ids=${chunk.join(',')}&fields=${PREVIEW_FIELDS}`);
    for (const [id, value] of Object.entries(data || {})) {
      // The response envelope mixes real ads with internal keys such as
      // __fb_trace_id__ / __www_request_id__. Only numeric ids are ads.
      if (!/^\d+$/.test(id)) continue;
      const clean = Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('__')));
      rows.push({ adId: id, ...clean });
    }
  }
  return rows;
}

export async function fetchAdNames(adIds) {
  const rows = await fetchPreviews(adIds);
  return Object.fromEntries(rows.map((row) => [row.adId, row.name || '']));
}

export async function listAdsets(accountId, { after = null, statuses = [] } = {}) {
  const fields = 'id,name,campaign_id,effective_status,created_time,campaign{name}';
  let endpoint = `act_${accountId}/adsets?fields=${fields}&limit=100`;
  if (statuses.length) endpoint += `&effective_status=${encodeURIComponent(`[${statuses.map((s) => `'${s}'`).join(',')}]`)}`;
  if (after) endpoint += `&after=${after}`;
  return call(endpoint);
}

export async function createDuplicateAd({ targetAdsetId, accountId, sourceAd, trackingSpecs }) {
  const body = {
    adset_id: targetAdsetId,
    creative: { creative_id: sourceAd.creative.id },
    name: sourceAd.name,
    status: sourceAd.status,
  };
  if (trackingSpecs.length) body.tracking_specs = trackingSpecs;
  const result = await call(`act_${accountId}/ads`, { method: 'POST', body, retry: false });
  if (!result?.id) throw new ApiError('Meta did not return an ad id.');
  return result.id;
}

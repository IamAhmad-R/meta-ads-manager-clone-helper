import { fetchAd, fetchCreative, createCreative, setAdCreative, createDuplicateAd } from '../lib/api.js';
import { getSyncSettings } from '../config.js';
import { mapLimit } from '../lib/pool.js';
import { convertCarousel, isConvertibleCarousel, cardCountError } from './carousel.js';

export async function convertCarousels(adIds, selectedPlacementIds, onProgress, onSkipPrompt) {
  const results = [];

  for (let index = 0; index < adIds.length; index += 1) {
    const adId = adIds[index];
    onProgress?.(index + 1, adIds.length, adId);
    try {
      const { creative } = await fetchCreative(adId);

      if (!isConvertibleCarousel(creative)) {
        const skip = await onSkipPrompt?.(adId, cardCountError(creative));
        if (skip) {
          results.push({ adId, success: false, skipped: true, error: 'Not a carousel ad — skipped.' });
          continue;
        }
        throw new Error('Conversion cancelled.');
      }

      const payload = convertCarousel(creative, selectedPlacementIds);
      const newCreativeId = await createCreative(creative.account_id, payload);
      await setAdCreative(adId, newCreativeId);
      results.push({ adId, success: true, newCreativeId });
    } catch (error) {
      if (error.message === 'Conversion cancelled.') throw error;
      results.push({ adId, success: false, error: error.message });
    }
  }

  return results;
}

const ALLOWED_TRACKING_TYPES = ['offsite_conversion', 'offline_conversion'];

export function filterTrackingSpecs(specs) {
  if (!Array.isArray(specs)) return [];
  return specs
    .map((spec) => {
      const allowed = (spec['action.type'] || []).filter((type) => ALLOWED_TRACKING_TYPES.includes(type));
      if (!allowed.length) return null;
      return { ...spec, 'action.type': allowed };
    })
    .filter(Boolean);
}

export async function duplicateAds(sourceAdIds, targetAdsetIds, onProgress) {
  const settings = await getSyncSettings();
  const sources = [];

  for (const adId of sourceAdIds) {
    const ad = await fetchAd(adId);
    sources.push(ad);
  }

  const pairs = [];
  for (const source of sources) {
    for (const adsetId of targetAdsetIds) pairs.push({ source, adsetId });
  }

  let done = 0;

  return mapLimit(pairs, settings.concurrency, async ({ source, adsetId }) => {
    let row;
    try {
      const newAdId = await createDuplicateAd({
        targetAdsetId: adsetId,
        accountId: source.account_id,
        sourceAd: source,
        trackingSpecs: filterTrackingSpecs(source.tracking_specs),
      });
      row = { sourceAdId: source.id, adsetId, success: true, newAdId };
    } catch (error) {
      row = {
        sourceAdId: source.id,
        adsetId,
        success: false,
        error: error.message,
        retryable: error.retryable === true,
      };
    }

    done += 1;
    onProgress?.(done, pairs.length, source.name);
    return row;
  });
}

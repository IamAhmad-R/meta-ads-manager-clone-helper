import { ENHANCEMENTS } from '../enhancements.js';
import { getSyncSettings } from '../config.js';
import { fetchCreative, createCreative, setAdCreative, fetchCreativeState } from '../lib/api.js';
import { mapLimit } from '../lib/pool.js';

// Standalone destination-level enhancements. Each one is a sibling of
// object_story_spec, is only touched when the source creative already has it,
// and is only touched when the matching setting is on.
function applyDestinationToggles(creative, settings) {
  const website = creative.destination_spec?.website?.optimization;
  if (settings.pdOptimizeWebsiteDestination && website) {
    website.status = 'OPT_OUT';
  }

  const browsing = creative.destination_spec?.native_commerce_experience?.product_browsing;
  if (settings.pdProductBrowsing && browsing) {
    browsing.enroll_status = 'OPT_OUT';
  }
}

function buildCreativeSpec(creative) {
  const hasProductSet = Boolean(creative.product_set_id);
  const spec = {};

  for (const { key, when } of ENHANCEMENTS) {
    if (when === 'never') continue;
    if (when === 'has_product_set' && !hasProductSet) continue;
    spec[key] = { enroll_status: 'OPT_OUT' };
  }

  // Legacy mega-key: never send it back, its children are enumerated above.
  delete spec.standard_enhancements;

  return spec;
}

export function buildCreativePayload(sourceCreative, settings) {
  const { id, account_id, ...creative } = sourceCreative;
  void id;
  void account_id;

  creative.degrees_of_freedom_spec = { creative_features_spec: buildCreativeSpec(creative) };
  creative.contextual_multi_ads = { enroll_status: 'OPT_OUT' };

  const feed = { ...(creative.asset_feed_spec || {}) };

  // Metadata ads auto-generate audio; opting out removes it.
  feed.audios = [{ type: 'opted_out' }];
  // Clears auto-added promo codes / site links added through asset feed.
  feed.promotional_metadata = {};

  if (settings.pdBrowserAddons && feed.call_ads_configuration) {
    delete feed.call_ads_configuration;
  }

  if (Array.isArray(feed.videos)) {
    feed.videos = feed.videos.map((video) => {
      if (video.thumbnail_url && video.thumbnail_url.includes('fbcdn.net')) {
        const { thumbnail_url, ...rest } = video;
        void thumbnail_url;
        return rest;
      }
      return video;
    });
  }

  creative.asset_feed_spec = feed;

  const linkData = creative.object_story_spec?.link_data;
  if (linkData) {
    if (linkData.multi_share_end_card) linkData.multi_share_end_card = false;
    if (linkData.multi_share_optimized) linkData.multi_share_optimized = false;
  }

  const videoData = creative.object_story_spec?.video_data;
  if (videoData?.image_url && videoData.image_hash) delete videoData.image_url;

  // Site links, catalog items and promo codes are sourced refinements; an
  // empty spec means none are carried over.
  creative.creative_sourcing_spec = {};

  applyDestinationToggles(creative, settings);

  return creative;
}

/**
 * Builds a creative that points at the ad's existing post instead of creating a
 * new unpublished post. Likes, comments and shares live on the post, so this is
 * the only way to change creative settings without resetting social proof.
 *
 * Meta may return the post's existing creative instead of a new one (documented
 * limitation when an object_story_id is already in use). The read-back catches
 * that: the enhancements then show as not applied.
 */
export function buildPostCreativePayload(creative, basePayload, adName) {
  const postId = creative.effective_object_story_id || creative.object_story_id;
  if (!postId) return null;

  const payload = {
    name: `${adName || 'Ad'} – enhancements off`.slice(0, 100),
    object_story_id: postId,
    degrees_of_freedom_spec: basePayload.degrees_of_freedom_spec,
    contextual_multi_ads: basePayload.contextual_multi_ads,
  };
  if (basePayload.destination_spec) payload.destination_spec = basePayload.destination_spec;
  if (basePayload.url_tags) payload.url_tags = basePayload.url_tags;
  if (basePayload.authorization_category) payload.authorization_category = basePayload.authorization_category;
  return payload;
}

export async function turnOffEnhancements(adIds, onProgress) {
  const settings = await getSyncSettings();
  const total = adIds.length;
  let done = 0;

  const results = await mapLimit(adIds, settings.concurrency, async (adId) => {
    let row;
    try {
      const { creative, name: adName } = await fetchCreative(adId);
      const accountId = creative.account_id;
      if (!accountId) throw new Error('Could not determine the ad account for this creative.');

      const sourceCreativeId = creative.id || null;
      const sourcePostId =
        creative.effective_object_story_id || creative.object_story_id || null;

      const base = buildCreativePayload(creative, settings);
      const expectedKeys = Object.keys(base.degrees_of_freedom_spec.creative_features_spec);

      let newCreativeId = null;
      let socialProof = settings.preserveSocialProof ? 'reset' : 'disabled';
      let note = '';

      if (settings.preserveSocialProof && !creative.asset_feed_spec) {
        const postPayload = buildPostCreativePayload(creative, base, adName);
        if (postPayload) {
          try {
            const createdId = await createCreative(accountId, postPayload);
            newCreativeId = createdId;
            socialProof = 'preserved';
            if (String(createdId) === String(creative.id)) {
              note =
                'Meta returned the ad’s existing creative for this post, so the enhancements were left unchanged. Turn off “Keep likes and comments” to force a new post.';
            }
          } catch (error) {
            note = `Meta did not reuse the existing post (${error.message}); a new post was created, so likes/comments start at zero.`;
          }
        }
      }

      if (!newCreativeId) {
        newCreativeId = await createCreative(accountId, base);
      }

      await setAdCreative(adId, newCreativeId);

      // Read the creative back: Meta can drop or re-enrol features after the
      // request, so the API answer is the only trustworthy one.
      let state = { notOff: [], destinationOn: [], specPresent: null };
      if (settings.verifyCreatives) {
        try {
          state = await fetchCreativeState(newCreativeId, expectedKeys);
        } catch {
          state = { notOff: [], destinationOn: [], specPresent: null };
        }
      }

      row = {
        adId,
        success: true,
        sourceCreativeId,
        sourcePostId,
        newCreativeId,
        notOff: state.notOff,
        destinationOn: state.destinationOn,
        specPresent: state.specPresent,
        verified: settings.verifyCreatives,
        socialProof,
        note,
      };
    } catch (error) {
      row = { adId, success: false, error: error.message, retryable: error.retryable === true };
    }

    done += 1;
    onProgress?.(done, total, adId);
    return row;
  });

  await logEnhancementRuns(results);
  return results;
}

const LOG_KEY = 'enhancementLog';

async function logEnhancementRuns(rows) {
  try {
    const bag = await chrome.storage.local.get(LOG_KEY);
    const existing = Array.isArray(bag[LOG_KEY]) ? bag[LOG_KEY] : [];
    const entries = rows
      .filter((row) => row.success)
      .map((row) => ({
        at: new Date().toISOString(),
        adId: row.adId,
        sourceCreativeId: row.sourceCreativeId,
        sourcePostId: row.sourcePostId,
        newCreativeId: row.newCreativeId,
        socialProof: row.socialProof,
      }));
    if (!entries.length) return;
    await chrome.storage.local.set({ [LOG_KEY]: [...entries, ...existing].slice(0, 500) });
  } catch {
    // Logging must never fail the batch.
  }
}

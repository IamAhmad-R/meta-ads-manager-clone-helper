// Shared constants and small storage helpers.

export const API_VERSIONS = ['v25.0', 'v24.0', 'v23.0'];

export const GRAPH = 'https://graph.facebook.com';

// Creative fields fetched before any creative is rebuilt. Removing or adding a
// field here changes which parts of the original creative survive the copy.
export const CREATIVE_FIELDS = [
  'id',
  'effective_object_story_id',
  'platform_customizations',
  'portrait_customizations',
  'product_set_id',
  'source_instagram_media_id',
  'template_url_spec',
  'template_url',
  'adlabels',
  'applink_treatment',
  'category_media_source',
  'creative_sourcing_spec',
  'dynamic_ad_voice',
  'destination_set_id',
  'interactive_components_spec',
  'account_id',
  'object_story_spec',
  'asset_feed_spec',
  'degrees_of_freedom_spec',
  'destination_spec',
  'object_story_id',
  'url_tags',
  'authorization_category',
  'contextual_multi_ads',
  'threads_user_id',
].join(',');

export const PREVIEW_FIELDS = [
  'id',
  'name',
  'preview_shareable_link',
  'adset{name}',
  'campaign{name}',
  'creative{effective_object_story_id,instagram_permalink_url,object_story_id}',
].join(',');

// Settings that only affect how much optional data is removed. All three
// "personalised destinations" switches default to on: the extension's promise is
// "remove the enhancements", and these are part of that set. Turning a switch
// off leaves the matching destination feature untouched.
export const SYNC_DEFAULTS = {
  sidebarMode: true,
  verboseMode: false,
  pdOptimizeWebsiteDestination: true,
  pdProductBrowsing: true,
  pdBrowserAddons: true,
  // Parallel Graph calls. 2 is a safe default for a single ad account; every
  // mutation counts against Meta's ad-account mutation rate limit.
  concurrency: 2,
  // Read each new creative back and report keys Meta did not keep.
  verifyCreatives: true,
  // Rebuild the creative on the ad's existing post (object_story_id) instead of
  // creating a fresh post, so likes/comments/shares stay on the same post.
  preserveSocialProof: true,
  // Reload the Ads Manager tab after a finished batch so the table is fresh.
  autoRefresh: true,
};

export async function getSyncSettings() {
  const stored = await chrome.storage.sync.get(SYNC_DEFAULTS);
  return { ...SYNC_DEFAULTS, ...stored };
}

export async function getSessionValue(key) {
  const bag = await chrome.storage.session.get(key);
  return bag[key];
}

export async function setSessionValue(key, value) {
  await chrome.storage.session.set({ [key]: value });
}

export async function clearSessionValue(key) {
  await chrome.storage.session.remove(key);
}

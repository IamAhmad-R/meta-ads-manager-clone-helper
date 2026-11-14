// Rebuilds a regular carousel as a placement-asset-customisation carousel:
// the first half of the cards becomes the default feed carousel, the second
// half becomes a separate carousel for each vertical placement that is turned on.

export const PLACEMENTS = [
  { id: 'default', label: 'Default placements (feed, in-stream, etc.)', usesFirstHalf: true },
  { id: 'instagram_story', label: 'Instagram Stories', platform: 'instagram', position: 'story', usesFirstHalf: false },
  { id: 'instagram_reels', label: 'Instagram Reels', platform: 'instagram', position: 'reels', usesFirstHalf: false },
  { id: 'instagram_profile_reels', label: 'Instagram profile Reels', platform: 'instagram', position: 'profile_reels', usesFirstHalf: false },
  { id: 'facebook_reels', label: 'Facebook Reels', platform: 'facebook', position: 'facebook_reels', usesFirstHalf: false },
  { id: 'facebook_story', label: 'Facebook Stories', platform: 'facebook', position: 'story', usesFirstHalf: false },
  { id: 'audience_network_classic', label: 'Audience Network native, banner and interstitial', platform: 'audience_network', position: 'classic', usesFirstHalf: false },
];

export const CARD_COUNTS = [4, 6, 8, 10];

const POSITION_FIELD = {
  facebook: 'facebook_positions',
  instagram: 'instagram_positions',
  messenger: 'messenger_positions',
  audience_network: 'audience_network_positions',
};

function splitCards(cards) {
  const half = Math.floor(cards.length / 2);
  return { first: cards.slice(0, half), second: cards.slice(half), half };
}

function allEqual(cards, get) {
  return cards.every((card) => (get(card) || '') === (get(cards[0]) || ''));
}

function labelFor(prefix, index, shared) {
  return shared ? `${prefix}1` : `${prefix}${index}`;
}

function buildCarousel(placement, cards, startIndex, assetIndex, shared, endCard, optimized) {
  const isVideo = Boolean(cards[0]?.video_id);
  return {
    multi_share_end_card: endCard ?? false,
    multi_share_optimized: optimized ?? false,
    adlabels: [{ name: `carousel_${placement.id}` }],
    child_attachments: cards.map((card, offset) => {
      const asset = assetIndex.get(startIndex + offset);
      return {
        description_label: { name: labelFor('description', asset, shared.descriptions) },
        [isVideo ? 'video_label' : 'image_label']: {
          name: `${isVideo ? 'video' : 'image'}${asset}`,
        },
        link_url_label: { name: labelFor('url', asset, shared.urls) },
        title_label: { name: labelFor('title', asset, shared.titles) },
      };
    }),
  };
}

function buildRule(placement) {
  const rule = {
    customization_spec: { age_min: 13, age_max: 65 },
    body_label: { name: 'primary_text' },
    link_url_label: { name: 'general_url' },
    carousel_label: { name: `carousel_${placement.id}` },
  };
  if (placement.platform) {
    rule.customization_spec.publisher_platforms = [placement.platform];
    const field = POSITION_FIELD[placement.platform];
    rule.customization_spec[field] = [placement.position];
  }
  return rule;
}

export function isConvertibleCarousel(creative) {
  const count = creative?.object_story_spec?.link_data?.child_attachments?.length ?? 0;
  return count > 0;
}

export function cardCountError(creative) {
  const count = creative?.object_story_spec?.link_data?.child_attachments?.length ?? 0;
  if (!count) return 'This ad is not a carousel ad.';
  if (!CARD_COUNTS.includes(count)) {
    return `This carousel has ${count} cards; only 4, 6, 8 or 10 cards can be converted.`;
  }
  return null;
}

export function convertCarousel(creative, selectedPlacementIds) {
  const {
    url_tags,
    object_story_spec: story,
    portrait_customizations,
    degrees_of_freedom_spec,
    authorization_category,
  } = creative;

  const linkData = story?.link_data;
  const cards = linkData?.child_attachments;
  if (!Array.isArray(cards) || !cards.length) throw new Error('This ad is not a carousel ad.');
  if (!linkData?.call_to_action?.type) {
    throw new Error('This carousel has no call to action, so it cannot be rebuilt as placement assets.');
  }
  if (!CARD_COUNTS.includes(cards.length)) {
    throw new Error(`This carousel has ${cards.length} cards; only 4, 6, 8 or 10 cards can be converted.`);
  }

  const active = PLACEMENTS.filter((placement) => selectedPlacementIds.includes(placement.id));
  if (!active.length) throw new Error('Select at least one placement.');

  const { first, second, half } = splitCards(cards);
  const isVideo = Boolean(cards[0]?.video_id);

  const shared = {
    titles: allEqual(cards, (card) => card.name),
    descriptions: allEqual(cards, (card) => card.description),
    urls: allEqual(cards, (card) => card.link),
  };

  // Asset indexes are assigned in original card order so every carousel can
  // reference one shared pool of images/videos.
  const usedIndices = new Set();
  for (const placement of active) {
    const slice = placement.usesFirstHalf ? first : second;
    const start = placement.usesFirstHalf ? 0 : half;
    slice.forEach((_, offset) => usedIndices.add(start + offset));
  }
  const ordered = [...usedIndices].sort((a, b) => a - b);
  const usedCards = ordered.map((index) => cards[index]);
  const assetIndex = new Map(ordered.map((original, position) => [original, position + 1]));

  const carousels = active.map((placement) =>
    buildCarousel(
      placement,
      placement.usesFirstHalf ? first : second,
      placement.usesFirstHalf ? 0 : half,
      assetIndex,
      shared,
      linkData.multi_share_end_card,
      linkData.multi_share_optimized,
    ),
  );

  const media = isVideo
    ? {
        videos: usedCards.map((card, index) => ({
          adlabels: [{ name: `video${index + 1}` }],
          video_id: card.video_id,
          thumbnail_url: card.picture || '',
        })),
      }
    : {
        images: usedCards.map((card, index) => ({
          adlabels: [{ name: `image${index + 1}` }],
          hash: card.image_hash,
        })),
      };

  const descriptions = shared.descriptions
    ? [{ adlabels: [{ name: 'description1' }], text: usedCards[0]?.description || '' }]
    : usedCards.map((card, index) => ({
        adlabels: [{ name: `description${index + 1}` }],
        text: card.description || '',
      }));

  const linkUrls = [
    { adlabels: [{ name: 'general_url' }], website_url: linkData.link, display_url: linkData.caption },
    ...(shared.urls
      ? [{ adlabels: [{ name: 'url1' }], website_url: usedCards[0]?.link || '' }]
      : usedCards.map((card, index) => ({
          adlabels: [{ name: `url${index + 1}` }],
          website_url: card.link || '',
        }))),
  ];

  const titles = shared.titles
    ? [{ adlabels: [{ name: 'title1' }], text: usedCards[0]?.name || '' }]
    : usedCards.map((card, index) => ({
        adlabels: [{ name: `title${index + 1}` }],
        text: card.name || '',
      }));

  const assetFeedSpec = {
    ...media,
    bodies: [{ adlabels: [{ name: 'primary_text' }], text: linkData.message || '' }],
    call_to_action_types: [linkData.call_to_action.type],
    call_to_actions: [{ type: linkData.call_to_action.type }],
    descriptions,
    link_urls: linkUrls,
    titles,
    ad_formats: ['CAROUSEL'],
    asset_customization_rules: active.map(buildRule),
    carousels,
    optimization_type: 'PLACEMENT',
    additional_data: {
      multi_share_end_card: linkData.multi_share_end_card ?? false,
      is_smart_app_promotion: false,
      is_click_to_message: false,
      is_pbia_messaging_enabled: false,
      is_crm_delivery_enabled: false,
    },
    reasons_to_shop: false,
    shops_bundle: false,
  };

  return {
    asset_feed_spec: assetFeedSpec,
    url_tags,
    object_story_spec: {
      page_id: story.page_id,
      instagram_actor_id: story.instagram_actor_id,
      instagram_user_id: story.instagram_user_id,
    },
    authorization_category: authorization_category || 'NONE',
    portrait_customizations,
    ...(degrees_of_freedom_spec ? { degrees_of_freedom_spec } : {}),
  };
}

import assert from "node:assert/strict";
import { parseAdIdsFromUrl, parseManualIds, shortPostId } from "../extension/src/lib/adIds.js";
import { convertCarousel, PLACEMENTS } from "../extension/src/features/carousel.js";
import { buildCreativePayload } from "../extension/src/features/enhancements.js";
import { buildPostCreativePayload } from "../extension/src/features/enhancements.js";
import { filterTrackingSpecs } from "../extension/src/features/duplicate.js";
import { toCsv, PREVIEW_COLUMNS } from "../extension/src/lib/csv.js";
import { ENHANCEMENTS } from "../extension/src/enhancements.js";
import { SYNC_DEFAULTS } from "../extension/src/config.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}\n     ${error.message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Ad selection
// ---------------------------------------------------------------------------

test("reads comma-separated selected_ad_ids", () => {
  const parsed = parseAdIdsFromUrl("https://www.facebook.com/adsmanager/manage/ads?act=123&selected_ad_ids=111,222,333");
  assert.deepEqual(parsed.adIds, ["111", "222", "333"]);
  assert.equal(parsed.isHash, false);
});

test("reads $selected_ad_ids", () => {
  const url = "https://www.facebook.com/adsmanager/manage/ads?act=1&%24selected_ad_ids=444%2C555";
  assert.deepEqual(parseAdIdsFromUrl(url).adIds, ["444", "555"]);
});

test("detects a hashed selection", () => {
  const url = "https://www.facebook.com/adsmanager/manage/ads?selected_ad_ids=03c736e9f3b0e44aa4cf42017816cce1";
  const parsed = parseAdIdsFromUrl(url);
  assert.equal(parsed.isHash, true);
  assert.deepEqual(parsed.adIds, []);
});

test("dedupes and trims manual ids", () => {
  assert.deepEqual(parseManualIds("111222, 333444\n333444;555666  not-an-id 4"), [
    "111222",
    "333444",
    "555666",
  ]);
});

test("no selection yields an empty list", () => {
  assert.deepEqual(parseAdIdsFromUrl("https://www.facebook.com/adsmanager/manage/ads").adIds, []);
});

test("post ids drop the page prefix", () => {
  assert.equal(shortPostId("117464686790068_1538833348267056"), "1538833348267056");
  assert.equal(shortPostId("1538833348267056"), "1538833348267056");
  assert.equal(shortPostId(""), "");
});

// ---------------------------------------------------------------------------
// Carousel conversion
// ---------------------------------------------------------------------------

function carouselCreative(cardCount = 6, { sameTitles = false } = {}) {
  const cards = Array.from({ length: cardCount }, (_, index) => ({
    image_hash: `hash${index + 1}`,
    link: `https://example.com/${index + 1}`,
    name: sameTitles ? "One title" : `Title ${index + 1}`,
    description: `Description ${index + 1}`,
    call_to_action: { type: "SHOP_NOW" },
  }));
  return {
    id: "creative_1",
    account_id: "999",
    url_tags: "utm_source=meta",
    object_story_spec: {
      page_id: "page_1",
      instagram_actor_id: "ig_1",
      link_data: {
        link: "https://example.com",
        message: "Primary text",
        caption: "example.com",
        call_to_action: { type: "SHOP_NOW" },
        child_attachments: cards,
        multi_share_end_card: true,
        multi_share_optimized: false,
      },
    },
  };
}

test("builds one carousel per selected placement", () => {
  const creative = carouselCreative(6);
  const selected = PLACEMENTS.map((placement) => placement.id);
  const payload = convertCarousel(creative, selected);
  const feed = payload.asset_feed_spec;

  assert.equal(feed.carousels.length, selected.length);
  assert.equal(feed.asset_customization_rules.length, selected.length);
  assert.equal(feed.images.length, 6);
  assert.equal(feed.ad_formats[0], "CAROUSEL");
  assert.equal(feed.optimization_type, "PLACEMENT");

  const [feedCarousel, storyCarousel] = feed.carousels;
  assert.deepEqual(
    feedCarousel.child_attachments.map((card) => card.image_label.name),
    ["image1", "image2", "image3"],
  );
  assert.deepEqual(
    storyCarousel.child_attachments.map((card) => card.image_label.name),
    ["image4", "image5", "image6"],
  );
  assert.equal(feedCarousel.adlabels[0].name, "carousel_default");
  assert.equal(storyCarousel.adlabels[0].name, "carousel_instagram_story");
});

test("default rule has no platform, story rule targets Instagram story", () => {
  const feed = convertCarousel(carouselCreative(6), ["default", "instagram_story"]).asset_feed_spec;
  const [defaultRule, storyRule] = feed.asset_customization_rules;
  assert.equal(defaultRule.customization_spec.publisher_platforms, undefined);
  assert.deepEqual(storyRule.customization_spec.publisher_platforms, ["instagram"]);
  assert.deepEqual(storyRule.customization_spec.instagram_positions, ["story"]);
});

test("identical titles collapse to one title asset", () => {
  const feed = convertCarousel(carouselCreative(4, { sameTitles: true }), ["default"]).asset_feed_spec;
  assert.equal(feed.titles.length, 1);
  assert.equal(feed.titles[0].adlabels[0].name, "title1");
  assert.equal(feed.carousels[0].child_attachments[0].title_label.name, "title1");
});

test("rejects unsupported card counts", () => {
  assert.throws(() => convertCarousel(carouselCreative(5), ["default"]), /only 4, 6, 8 or 10/);
});

test("rejects an empty placement selection", () => {
  assert.throws(() => convertCarousel(carouselCreative(6), []), /at least one placement/);
});

test("video carousels use video labels", () => {
  const creative = carouselCreative(4);
  for (const card of creative.object_story_spec.link_data.child_attachments) {
    card.video_id = card.image_hash;
    delete card.image_hash;
    card.picture = "https://cdn.example.com/thumb.jpg";
  }
  const feed = convertCarousel(creative, ["default"]).asset_feed_spec;
  assert.equal(feed.videos.length, 2);
  assert.equal(feed.images, undefined);
  assert.equal(feed.carousels[0].child_attachments[0].video_label.name, "video1");
});

// ---------------------------------------------------------------------------
// Creative payload
// ---------------------------------------------------------------------------

function sourceCreative() {
  return {
    id: "creative_2",
    account_id: "999",
    product_set_id: "ps_1",
    object_story_spec: {
      page_id: "page_1",
      video_data: { image_hash: "img_1", image_url: "https://scontent.xx.fbcdn.net/auto.jpg" },
      link_data: { multi_share_end_card: true, multi_share_optimized: true },
    },
    asset_feed_spec: {
      videos: [{ video_id: "v1", thumbnail_url: "https://scontent.xx.fbcdn.net/thumb.jpg" }],
      call_ads_configuration: { phone_number: "123" },
    },
    degrees_of_freedom_spec: {
      creative_features_spec: {
        product_browsing: { enroll_status: "OPT_IN" },
        something_else: { enroll_status: "OPT_IN" },
      },
    },
    destination_spec: {
      website: { optimization: { status: "OPT_IN" } },
      native_commerce_experience: { product_browsing: { enroll_status: "OPT_IN" } },
    },
  };
}

const OFF = {
  pdOptimizeWebsiteDestination: false,
  pdProductBrowsing: false,
  pdBrowserAddons: false,
};

test("payload opts out every active enhancement key", () => {
  const payload = buildCreativePayload(sourceCreative(), OFF);
  const spec = payload.degrees_of_freedom_spec.creative_features_spec;
  const activeKeys = ENHANCEMENTS.filter((row) => row.when !== "never").length;
  assert.equal(Object.keys(spec).length, activeKeys);
  assert.equal(spec.text_optimizations.enroll_status, "OPT_OUT");
  assert.equal(spec.hide_price.enroll_status, "OPT_OUT"); // catalog key, product set present
  assert.equal(spec.optimize_website_destination, undefined);
  assert.equal(payload.contextual_multi_ads.enroll_status, "OPT_OUT");
});

test("catalog-only keys are skipped without a product set", () => {
  const creative = sourceCreative();
  delete creative.product_set_id;
  const spec = buildCreativePayload(creative, OFF).degrees_of_freedom_spec.creative_features_spec;
  assert.equal(spec.hide_price, undefined);
  assert.equal(spec.standard_enhancements_catalog, undefined);
});

test("asset feed audio and promo metadata are cleared", () => {
  const payload = buildCreativePayload(sourceCreative(), OFF);
  assert.deepEqual(payload.asset_feed_spec.audios, [{ type: "opted_out" }]);
  assert.deepEqual(payload.asset_feed_spec.promotional_metadata, {});
  assert.deepEqual(payload.creative_sourcing_spec, {});
});

test("fbcdn thumbnails are dropped, custom thumbnails kept", () => {
  const creative = sourceCreative();
  creative.asset_feed_spec.videos = [
    { video_id: "v1", thumbnail_url: "https://scontent.xx.fbcdn.net/a.jpg" },
    { video_id: "v2", thumbnail_url: "https://cdn.example.com/mine.jpg" },
  ];
  const videos = buildCreativePayload(creative, OFF).asset_feed_spec.videos;
  assert.equal(videos[0].thumbnail_url, undefined);
  assert.equal(videos[1].thumbnail_url, "https://cdn.example.com/mine.jpg");
});

test("destination toggles are left alone when switched off", () => {
  const payload = buildCreativePayload(sourceCreative(), OFF);
  assert.equal(payload.destination_spec.website.optimization.status, "OPT_IN");
  assert.equal(payload.destination_spec.native_commerce_experience.product_browsing.enroll_status, "OPT_IN");
  assert.equal(payload.asset_feed_spec.call_ads_configuration.phone_number, "123");
});

test("personalised destination switches opt out when enabled", () => {
  const payload = buildCreativePayload(sourceCreative(), {
    pdOptimizeWebsiteDestination: true,
    pdProductBrowsing: true,
    pdBrowserAddons: true,
  });
  assert.equal(payload.destination_spec.website.optimization.status, "OPT_OUT");
  assert.equal(payload.destination_spec.native_commerce_experience.product_browsing.enroll_status, "OPT_OUT");
  assert.equal(payload.asset_feed_spec.call_ads_configuration, undefined);
  assert.equal(payload.degrees_of_freedom_spec.creative_features_spec.product_browsing.enroll_status, "OPT_OUT");
});

test("product browsing is opted out in the creative spec even when its switch is off", () => {
  const payload = buildCreativePayload(sourceCreative(), OFF);
  assert.equal(
    payload.degrees_of_freedom_spec.creative_features_spec.product_browsing.enroll_status,
    "OPT_OUT",
  );
});

test("product showcase opt-out is a plain OPT_OUT", () => {
  const spec = buildCreativePayload(sourceCreative(), OFF).degrees_of_freedom_spec.creative_features_spec;
  assert.deepEqual(spec.product_extensions, { enroll_status: "OPT_OUT" });
});

test("creative id and account id never travel into the new creative", () => {
  const payload = buildCreativePayload(sourceCreative(), OFF);
  assert.equal(payload.id, undefined);
  assert.equal(payload.account_id, undefined);
});

test("unknown creative spec keys are not carried over", () => {
  const payload = buildCreativePayload(sourceCreative(), OFF);
  const spec = payload.degrees_of_freedom_spec.creative_features_spec;
  assert.equal(spec.something_else, undefined);
  assert.equal(spec.standard_enhancements, undefined);
});

// ---------------------------------------------------------------------------
// Tracking specs + CSV
// ---------------------------------------------------------------------------

test("post reuse payload keeps the existing post and the opt-outs", () => {
  const base = buildCreativePayload(sourceCreative(), OFF);
  const payload = buildPostCreativePayload(
    { effective_object_story_id: "page_1_post_1", object_story_id: null },
    base,
    "Spring carousel",
  );
  assert.equal(payload.object_story_id, "page_1_post_1");
  assert.equal(payload.object_story_spec, undefined, "object_story_spec must not travel with object_story_id");
  assert.equal(payload.asset_feed_spec, undefined, "asset feed cannot be combined with a reused post");
  assert.equal(
    payload.degrees_of_freedom_spec.creative_features_spec.product_extensions.enroll_status,
    "OPT_OUT",
  );
  assert.equal(payload.contextual_multi_ads.enroll_status, "OPT_OUT");
  assert(payload.name.length <= 100, "creative names cap at 100 chars");
});

test("no post id means no post-reuse payload", () => {
  assert.equal(buildPostCreativePayload({}, { degrees_of_freedom_spec: {} }, "Ad"), null);
});

test("personalised destination switches default to on", () => {
  assert.equal(SYNC_DEFAULTS.pdOptimizeWebsiteDestination, true);
  assert.equal(SYNC_DEFAULTS.pdProductBrowsing, true);
  assert.equal(SYNC_DEFAULTS.pdBrowserAddons, true);
  assert.equal(SYNC_DEFAULTS.preserveSocialProof, true);
});

test("only conversion tracking specs survive duplication", () => {
  const specs = [
    { "action.type": ["offsite_conversion"], "fb_pixel": ["1"] },
    { "action.type": ["link_click"] },
    { "action.type": ["offline_conversion", "post_engagement"] },
  ];
  const kept = filterTrackingSpecs(specs);
  assert.equal(kept.length, 2);
  assert.deepEqual(kept[1]["action.type"], ["offline_conversion"]);
});

test("csv escapes commas and quotes", () => {
  const csv = toCsv(
    [{ adId: "1", name: 'Ad, "quoted"', adset: { name: "AS" }, campaign: { name: "C" } }],
    PREVIEW_COLUMNS,
  );
  const [header, row] = csv.split("\r\n");
  assert.match(header, /^Ad ID,Ad name/);
  assert.match(row, /"Ad, ""quoted"""/);
});

console.log(`\n${passed} checks passed${process.exitCode ? " — with failures" : ""}`);

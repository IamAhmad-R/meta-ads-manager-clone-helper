import { toCsv, PREVIEW_COLUMNS, downloadCsv, copyText } from '../src/lib/csv.js';
import { parseAdIdsFromUrl, parseManualIds, shortPostId } from '../src/lib/adIds.js';
import { PLACEMENTS } from '../src/features/carousel.js';

const $ = (id) => document.getElementById(id);

const state = {
  adIds: [],
  isHash: false,
  manual: false,
  names: {},
  accountId: null,
  previewRows: [],
  lastKey: '',
};

const els = {
  selectionTitle: $('selectionTitle'),
  selectionSub: $('selectionSub'),
  hashNotice: $('hashNotice'),
  adNames: $('adNames'),
  manualWrap: $('manualWrap'),
  manualIds: $('manualIds'),
  toggleManual: $('toggleManual'),
  refresh: $('refresh'),
  actions: $('actions'),
  tableView: $('tableView'),
  tableHint: $('tableHint'),
  status: $('status'),
  busy: $('busy'),
  busyText: $('busyText'),
  busySub: $('busySub'),
  sessionState: $('sessionState'),
};

if (new URLSearchParams(location.search).get('mode') === 'sidebar') {
  document.body.classList.add('sidebar');
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

async function send(action, payload = {}) {
  const response = await chrome.runtime.sendMessage({ action, ...payload });
  if (!response) throw new Error('The background worker did not answer. Reload the extension and retry.');
  if (!response.ok) throw new Error(response.error || 'Unknown error');
  return response.result;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function hardReload() {
  const tab = await activeTab();
  if (!tab?.id) return;
  try {
    await chrome.tabs.reload(tab.id, { bypassCache: true });
  } catch {
    await chrome.tabs.reload(tab.id);
  }
}

function isAdsManager(url) {
  return typeof url === 'string' && url.includes('facebook.com') && url.includes('adsmanager');
}

// ---------------------------------------------------------------------------
// Ad ID selection
// ---------------------------------------------------------------------------

function applySelection(adIds, { isHash = false } = {}) {
  const key = `${adIds.join(',')}|${isHash}`;
  state.adIds = adIds;
  state.isHash = isHash;
  if (key === state.lastKey) return;
  state.lastKey = key;
  state.previewRows = [];
  renderSelection();
  loadNames();
  setSessionHint();
}

function renderSelection() {
  const count = state.adIds.length;
  els.selectionTitle.textContent = count === 1 ? '1 ad selected' : `${count} ads selected`;
  if (count === 0) {
    els.selectionSub.textContent = state.isHash
      ? 'Selection is hash-only — enter ad IDs manually.'
      : 'Select ads in Ads Manager, or enter IDs manually.';
  } else {
    const account = state.accountId ? ` · account ${state.accountId}` : '';
    els.selectionSub.textContent = `Ready to run${account}`;
  }
  els.hashNotice.hidden = !state.isHash;
  $('actions').querySelectorAll('button[data-feature]').forEach((button) => {
    button.disabled = count === 0;
  });
}

async function refreshSelection() {
  const tab = await activeTab();
  if (!tab || !isAdsManager(tab.url)) {
    state.adIds = [];
    state.isHash = false;
    els.selectionTitle.textContent = 'Open Meta Ads Manager';
    els.selectionSub.textContent = 'This helper only runs on adsmanager.facebook.com.';
    els.hashNotice.hidden = true;
    els.adNames.hidden = true;
    $('actions').querySelectorAll('button').forEach((button) => {
      button.disabled = true;
    });
    return;
  }
  const parsed = parseAdIdsFromUrl(tab.url);
  if (state.manual && !parsed.adIds.length) return;
  applySelection(parsed.adIds, { isHash: parsed.isHash });
}

async function loadNames() {
  const ids = state.adIds.slice(0, 50);
  if (!ids.length) {
    els.adNames.hidden = true;
    return;
  }
  try {
    const names = await send('adNames', { adIds: ids });
    state.names = names;
    const entries = Object.entries(names).filter(([id]) => /^\d+$/.test(id));
    els.adNames.replaceChildren();
    for (const [id, name] of entries.slice(0, 12)) {
      const row = document.createElement('div');
      row.textContent = `${name || '(no name)'} · ${id}`;
      els.adNames.appendChild(row);
    }
    if (state.adIds.length > 12) {
      const more = document.createElement('div');
      more.textContent = `+ ${state.adIds.length - 12} more`;
      els.adNames.appendChild(more);
    }
    els.adNames.hidden = entries.length === 0;
  } catch (error) {
    els.adNames.hidden = true;
    void error;
  }
}

// ---------------------------------------------------------------------------
// Status / busy
// ---------------------------------------------------------------------------

function showStatus(message, kind = '') {
  els.status.textContent = message;
  els.status.className = `status ${kind}`.trim();
  els.status.hidden = !message;
}

function secondsSince(start) {
  return `${((performance.now() - start) / 1000).toFixed(1)}s`;
}

function setBusy(message, sub = '') {
  els.busyText.textContent = message;
  els.busySub.textContent = sub;
  els.busy.hidden = false;
}

function clearBusy() {
  els.busy.hidden = true;
}

async function setSessionHint() {
  try {
    const { hasToken } = await send('ping');
    els.sessionState.textContent = hasToken ? 'Session: connected' : 'Session: open Ads Manager';
    els.sessionState.style.color = hasToken ? 'var(--success)' : 'var(--muted)';
  } catch {
    els.sessionState.textContent = 'Session: unknown';
  }
}

// ---------------------------------------------------------------------------
// Result dialog
// ---------------------------------------------------------------------------

const resultDialog = $('resultDialog');
let lastResults = null;

function showResults(title, groups, details = null) {
  $('resultTitle').textContent = title;
  const body = $('resultBody');
  body.replaceChildren();
  lastResults = details;
  $('copyResultDetails').hidden = !details;
  const canReload = Array.isArray(details)
    ? details.some((row) => row.success)
    : Boolean(details?.adsetId || details?.campaignId);
  $('reloadAfterRun').hidden = !canReload;

  for (const group of groups) {
    if (!group.items.length) continue;
    const section = document.createElement('div');
    section.className = `result-group ${group.kind === 'ok' ? 'result-ok' : 'result-fail'}`;
    const heading = document.createElement('h3');
    heading.textContent = `${group.title} (${group.items.length})`;
    const list = document.createElement('ul');
    list.className = 'result-list';
    for (const item of group.items.slice(0, 100)) {
      const li = document.createElement('li');
      li.textContent = item;
      list.appendChild(li);
    }
    if (group.items.length > 100) {
      const li = document.createElement('li');
      li.textContent = `… and ${group.items.length - 100} more`;
      list.appendChild(li);
    }
    section.append(heading, list);
    body.appendChild(section);
  }

  if (!body.childElementCount) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Nothing to report.';
    body.appendChild(p);
  }

  resultDialog.showModal();
}

const FEATURE_LABELS = {
  product_extensions: 'Show products',
  product_browsing: 'Product browsing',
  image_touchups: 'Visual touch-ups',
  image_uncrop: 'Expand image',
  image_brightness_and_contrast: 'Brightness and contrast',
  video_auto_crop: 'Visual touch-ups (video)',
  video_uncrop: 'Expand video',
  text_optimizations: 'Text improvements',
  inline_comment: 'Relevant comments',
  enhance_cta: 'Enhance CTA',
  image_templates: 'Add overlays',
  image_animation: 'Image animation',
  description_automation: 'Dynamic description',
  'destination:optimize_website_destination': 'Optimise website destination',
  'destination:product_browsing': 'Product browsing (destination)',
  'sourcing:associated_product_set_id': 'Product set attached (Show products)',
};

function featureName(key) {
  const label = FEATURE_LABELS[key];
  return label ? `${label} (${key})` : key;
}

function summarizeResults(results) {
  const ok = results.filter((row) => row.success);
  const skipped = results.filter((row) => row.success === false && row.skipped);
  const failed = results.filter((row) => row.success === false && !row.skipped);
  const stillOn = results.filter((row) => row.success && problemsOf(row).length);
  const groups = [];

  if (ok.length) {
    groups.push({
      kind: 'ok',
      title: 'Succeeded',
      items: ok.map((row) => {
        if (row.newAdId) return `${row.sourceAdId ?? row.adId} → new ad ${row.newAdId}`;
        if (row.newCreativeId) {
          const proof = row.socialProof === 'preserved' ? ' · post kept' : row.socialProof === 'reset' ? ' · new post' : '';
          return `Ad ${row.adId} → new creative ${row.newCreativeId}${proof}`;
        }
        return `Ad ${row.adId}`;
      }),
    });
  }
  if (skipped.length) {
    groups.push({
      kind: 'fail',
      title: 'Skipped',
      items: skipped.map((row) => `Ad ${row.adId}: ${row.error || 'skipped'}`),
    });
  }
  if (failed.length) {
    groups.push({
      kind: 'fail',
      title: 'Failed',
      items: failed.map((row) => `Ad ${row.sourceAdId ?? row.adId}: ${row.error || 'unknown error'}`),
    });
  }
  const warnings = results.filter((row) => row.success && row.note);
  if (warnings.length) {
    groups.push({
      kind: 'fail',
      title: 'Warnings',
      items: warnings.map((row) => `Ad ${row.adId}: ${row.note}`),
    });
  }
  if (stillOn.length) {
    groups.push({
      kind: 'fail',
      title: 'Not off after the rebuild',
      items: stillOn.map((row) => {
        const problems = problemsOf(row).map(featureName).join(', ');
        const dropped = row.specPresent === 0 ? ' — Meta returned no feature spec at all' : '';
        return `Ad ${row.adId}: ${problems}${dropped}`;
      }),
    });
  }
  return groups;
}

function problemsOf(row) {
  return [...(row.notOff || []), ...(row.destinationOn || [])];
}

// ---------------------------------------------------------------------------
// Feature: creative enhancements
// ---------------------------------------------------------------------------

async function runEnhancements() {
  const dialog = $('confirmEnhanceDialog');
  $('confirmEnhanceCount').textContent = `${state.adIds.length} ad${state.adIds.length === 1 ? '' : 's'} selected.`;
  dialog.showModal();
  const decision = await new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
  });
  if (decision !== 'go') return;

  showStatus('');
  const started = performance.now();
  setBusy('Removing creative enhancements…', `0 of ${state.adIds.length}`);
  try {
    const results = await send('turnOffEnhancements', { adIds: state.adIds });
    clearBusy();
    const failed = results.filter((row) => !row.success).length;
    const stillOn = results.filter((row) => row.success && problemsOf(row).length).length;
    const droppedSpec = results.some((row) => row.success && row.specPresent === 0);
    const resetPosts = results.filter((row) => row.success && row.socialProof === 'reset').length;
    const suffix = ` · ${secondsSince(started)}`;
    showResults(
      failed ? 'Finished with errors' : stillOn ? 'Finished with items not off' : 'All creatives updated',
      summarizeResults(results),
      results,
    );
    const summary = `${results.length - failed} updated, ${failed} failed.`;
    showStatus(
      (droppedSpec
        ? `${summary} Meta returned the new creative without any feature spec, so the ad is unchanged. Use “Copy details” and share them.`
        : stillOn
          ? `${summary} ${stillOn} ad${stillOn === 1 ? ' still reports' : 's still report'} a feature that is not off — see the list.`
          : `${summary} Ads now use new creatives with enhancements opted out.`) +
        (resetPosts ? ` ${resetPosts} ad${resetPosts === 1 ? '' : 's'} could not keep the original post, so likes/comments restart at zero.` : '') +
        suffix,
      failed || stillOn ? 'error' : 'ok',
    );
  } catch (error) {
    clearBusy();
    showStatus(error.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Feature: previews
// ---------------------------------------------------------------------------

function cell(content) {
  const td = document.createElement('td');
  if (content instanceof Node) td.appendChild(content);
  else td.textContent = content ?? '';
  return td;
}

function renderPreviewTable(rows) {
  const table = $('previewTable');
  table.tHead.replaceChildren();
  table.tBodies[0].replaceChildren();

  const headers = ['Ad ID', 'Ad name', 'Ad set', 'Campaign', 'Preview link', 'Post ID', 'IG permalink'];
  const headRow = document.createElement('tr');
  headers.forEach((label) => {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  });
  table.tHead.appendChild(headRow);

  for (const row of rows) {
    const tr = document.createElement('tr');
    const postId = shortPostId(
      row.creative?.effective_object_story_id ?? row.creative?.object_story_id ?? '',
    );
    const previewLink = row.preview_shareable_link
      ? Object.assign(document.createElement('a'), {
          href: row.preview_shareable_link,
          target: '_blank',
          rel: 'noreferrer',
          textContent: 'Preview',
        })
      : '';
    const igLink = row.creative?.instagram_permalink_url
      ? Object.assign(document.createElement('a'), {
          href: row.creative.instagram_permalink_url,
          target: '_blank',
          rel: 'noreferrer',
          textContent: 'Instagram',
        })
      : '';
    const postCell = cell(postId);
    if (postId) {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'link';
      copy.textContent = 'Copy';
      copy.style.marginLeft = '6px';
      copy.addEventListener('click', async () => {
        const ok = await copyText(String(postId));
        showStatus(ok ? `Post ID copied: ${postId}` : 'Copy failed.', ok ? 'ok' : 'error');
      });
      postCell.appendChild(copy);
    }
    tr.append(
      cell(row.adId),
      cell(row.name),
      cell(row.adset?.name),
      cell(row.campaign?.name),
      cell(previewLink),
      postCell,
      cell(igLink),
    );
    table.tBodies[0].appendChild(tr);
  }
}

async function runPreviews() {
  showStatus('');
  const started = performance.now();
  setBusy('Fetching previews…', `0 of ${state.adIds.length}`);
  try {
    const rows = await send('previews', { adIds: state.adIds });
    state.previewRows = rows;
    clearBusy();
    renderPreviewTable(rows);
    $('tableHint').textContent = `${rows.length} of ${state.adIds.length} ads returned data · ${secondsSince(started)}. Copy or download as CSV.`;
    els.tableView.hidden = false;
    $('actions').hidden = true;
    $('selectionCard').hidden = true;
  } catch (error) {
    clearBusy();
    showStatus(error.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Feature: carousel conversion
// ---------------------------------------------------------------------------

const placementDialog = $('placementDialog');

function buildPlacementOptions() {
  const list = $('placementList');
  list.replaceChildren();
  for (const placement of PLACEMENTS) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = placement.id;
    input.checked = placement.id === 'default';
    const text = document.createElement('span');
    text.textContent = placement.label;
    label.append(input, text);
    list.appendChild(label);
  }
}

function selectedPlacements() {
  return [...$('placementList').querySelectorAll('input:checked')].map((input) => input.value);
}

async function runCarousel() {
  buildPlacementOptions();
  placementDialog.showModal();
  const decision = await new Promise((resolve) => {
    placementDialog.addEventListener('close', () => resolve(placementDialog.returnValue), { once: true });
  });
  if (decision !== 'go') return;

  const placements = selectedPlacements();
  if (!placements.length) {
    showStatus('Pick at least one placement.', 'error');
    return;
  }

  showStatus('');
  const started = performance.now();
  setBusy('Converting carousels…', `0 of ${state.adIds.length}`);
  try {
    const results = await send('convertCarousels', { adIds: state.adIds, placements });
    clearBusy();
    const failed = results.filter((row) => !row.success).length;
    showResults(failed ? 'Finished with errors' : 'Carousels converted', summarizeResults(results), results);
    showStatus(`${results.length - failed} converted, ${failed} failed · ${secondsSince(started)}.`, failed ? 'error' : 'ok');
  } catch (error) {
    clearBusy();
    showStatus(error.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Feature: duplication
// ---------------------------------------------------------------------------

const duplicateDialog = $('duplicateDialog');
const adsetState = {
  items: [],
  after: null,
  selected: new Set(),
  loading: false,
  statuses: [],
  search: '',
};

function campaignLabel(adset) {
  return adset.campaign?.name || `Campaign ${adset.campaign_id}`;
}

function visibleAdsets() {
  const query = adsetState.search.trim().toLowerCase();
  if (!query) return adsetState.items;
  return adsetState.items.filter((adset) =>
    `${adset.name} ${campaignLabel(adset)}`.toLowerCase().includes(query),
  );
}

function renderAdsets() {
  const list = $('adsetList');
  const visible = visibleAdsets();
  list.replaceChildren();

  $('loadedCount').textContent = `${adsetState.items.length} loaded`;
  const selectAll = $('selectAllAdsets');
  selectAll.checked = visible.length > 0 && visible.every((adset) => adsetState.selected.has(adset.id));
  selectAll.indeterminate =
    !selectAll.checked && visible.some((adset) => adsetState.selected.has(adset.id));

  if (!visible.length) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = adsetState.loading ? 'Loading ad sets…' : 'No ad sets match.';
    list.appendChild(hint);
    updateDuplicateSummary();
    return;
  }

  const groups = new Map();
  for (const adset of visible) {
    const key = adset.campaign_id || 'unknown';
    if (!groups.has(key)) groups.set(key, { label: campaignLabel(adset), items: [] });
    groups.get(key).items.push(adset);
  }

  for (const group of groups.values()) {
    const section = document.createElement('div');
    section.className = 'campaign-group';

    const head = document.createElement('label');
    head.className = 'campaign-head';
    const groupBox = document.createElement('input');
    groupBox.type = 'checkbox';
    groupBox.checked = group.items.every((adset) => adsetState.selected.has(adset.id));
    groupBox.addEventListener('change', () => {
      for (const adset of group.items) {
        if (groupBox.checked) adsetState.selected.add(adset.id);
        else adsetState.selected.delete(adset.id);
      }
      renderAdsets();
    });
    const name = document.createElement('span');
    name.className = 'campaign-name';
    name.textContent = group.label;
    head.append(groupBox, name);
    section.appendChild(head);

    for (const adset of group.items) {
      const row = document.createElement('label');
      row.className = 'adset-option';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = adsetState.selected.has(adset.id);
      box.addEventListener('change', () => {
        if (box.checked) adsetState.selected.add(adset.id);
        else adsetState.selected.delete(adset.id);
        updateDuplicateSummary();
      });
      const label = document.createElement('span');
      label.textContent = adset.name;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = (adset.effective_status || '').toLowerCase();
      row.append(box, label, meta);
      section.appendChild(row);
    }

    list.appendChild(section);
  }

  updateDuplicateSummary();
}

function updateDuplicateSummary() {
  const count = adsetState.selected.size;
  $('dupSummary').textContent = count
    ? `${state.adIds.length} ad${state.adIds.length === 1 ? '' : 's'} × ${count} ad set${count === 1 ? '' : 's'} = ${state.adIds.length * count} new ads.`
    : 'Select at least one ad set.';
  $('confirmDuplicate').disabled = count === 0;
}

async function loadAdsets({ reset = false } = {}) {
  if (adsetState.loading) return;
  if (reset) {
    adsetState.items = [];
    adsetState.after = null;
    adsetState.selected.clear();
  }
  adsetState.loading = true;
  renderAdsets();
  try {
    if (!state.accountId) {
      state.accountId = await send('accountId', { adIds: state.adIds });
      renderSelection();
    }
    const page = await send('adsets', {
      accountId: state.accountId,
      after: adsetState.after,
      statuses: adsetState.statuses,
    });
    adsetState.items.push(...(page.data || []));
    adsetState.after = page.paging?.cursors?.after ?? null;
    $('loadMoreAdsets').hidden = !adsetState.after;
  } catch (error) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = error.message;
    $('adsetList').replaceChildren(hint);
    showStatus(error.message, 'error');
  } finally {
    adsetState.loading = false;
    renderAdsets();
  }
}

async function openDuplicateDialog() {
  adsetState.search = '';
  $('adsetSearch').value = '';
  duplicateDialog.showModal();
  await loadAdsets({ reset: true });
}

async function runDuplication() {
  const adsetIds = [...adsetState.selected];
  if (!adsetIds.length) return;
  duplicateDialog.close();
  showStatus('');
  const started = performance.now();
  setBusy('Duplicating ads…', `0 of ${state.adIds.length * adsetIds.length}`);
  try {
    const results = await send('duplicateAds', { sourceAdIds: state.adIds, adsetIds });
    clearBusy();
    const failed = results.filter((row) => !row.success).length;
    showResults(failed ? 'Finished with errors' : 'Ads duplicated', summarizeResults(results), results);
    showStatus(
      `${results.length - failed} new ads created, ${failed} failed · ${secondsSince(started)}. The source creative ID was reused.`,
      failed ? 'error' : 'ok',
    );
  } catch (error) {
    clearBusy();
    showStatus(error.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Skip prompt (carousel batches)
// ---------------------------------------------------------------------------

const skipDialog = $('skipDialog');
let skipDialogOpen = false;

function askToSkip(adId, reason) {
  if (skipDialogOpen) return Promise.resolve(true);
  skipDialogOpen = true;
  $('skipReason').textContent = `Ad ${adId}: ${reason || 'This ad cannot be converted.'}`;
  skipDialog.showModal();
  return new Promise((resolve) => {
    skipDialog.addEventListener(
      'close',
      () => {
        skipDialogOpen = false;
        resolve(skipDialog.returnValue === 'skip');
      },
      { once: true },
    );
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === 'progress') {
    setBusy(message.message, `${message.current} of ${message.total}`);
    return false;
  }
  if (message?.action === 'askSkip') {
    askToSkip(message.adId, message.reason).then((skip) => sendResponse({ skip }));
    return true;
  }
  return false;
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$('refresh').addEventListener('click', async () => {
  await refreshSelection();
  showStatus('Selection refreshed.');
});

els.toggleManual.addEventListener('click', () => {
  state.manual = !state.manual;
  els.manualWrap.hidden = !state.manual;
  if (state.manual) els.manualIds.focus();
});

$('applyManual').addEventListener('click', () => {
  const ids = parseManualIds(els.manualIds.value);
  if (!ids.length) {
    showStatus('No valid numeric ad IDs found.', 'error');
    return;
  }
  applySelection(ids, { isHash: false });
  showStatus(`Using ${ids.length} ad IDs from manual entry.`);
});

$('cancelManual').addEventListener('click', () => {
  state.manual = false;
  els.manualWrap.hidden = true;
});

$('actions').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-feature]');
  if (!button || button.disabled) return;
  const feature = button.dataset.feature;
  if (feature === 'enhancements') runEnhancements();
  if (feature === 'previews') runPreviews();
  if (feature === 'carousel') runCarousel();
  if (feature === 'duplicate') openDuplicateDialog();
});

$('backToMain').addEventListener('click', () => {
  els.tableView.hidden = true;
  $('actions').hidden = false;
  $('selectionCard').hidden = false;
  showStatus('');
});

$('copyCsv').addEventListener('click', async () => {
  const ok = await copyText(toCsv(state.previewRows, PREVIEW_COLUMNS));
  showStatus(ok ? 'CSV copied to clipboard.' : 'Copy failed — use Download CSV.', ok ? 'ok' : 'error');
});

$('copyPostIds').addEventListener('click', async () => {
  const ids = [
    ...new Set(
      state.previewRows
        .map((row) => shortPostId(row.creative?.effective_object_story_id ?? row.creative?.object_story_id ?? ''))
        .filter(Boolean),
    ),
  ];
  if (!ids.length) {
    showStatus('No post IDs in the current table.', 'error');
    return;
  }
  const ok = await copyText(ids.join('\n'));
  showStatus(
    ok ? `${ids.length} post ID${ids.length === 1 ? '' : 's'} copied, one per line.` : 'Copy failed.',
    ok ? 'ok' : 'error',
  );
});

$('downloadCsv').addEventListener('click', () => {
  const stamp = new Date().toISOString().slice(0, 10);
  downloadCsv(`ad-previews-${stamp}.csv`, toCsv(state.previewRows, PREVIEW_COLUMNS));
});

$('openSheet').addEventListener('click', async () => {
  const ok = await copyText(toCsv(state.previewRows, PREVIEW_COLUMNS));
  window.open('https://docs.google.com/spreadsheets/create', '_blank', 'noopener');
  showStatus(
    ok ? 'CSV copied — paste it into the new sheet.' : 'Sheet opened, but the clipboard was blocked.',
    ok ? 'ok' : 'error',
  );
});

$('cancelDuplicate').addEventListener('click', () => duplicateDialog.close());
$('confirmDuplicate').addEventListener('click', runDuplication);
$('loadMoreAdsets').addEventListener('click', () => loadAdsets());
$('adsetSearch').addEventListener('input', (event) => {
  adsetState.search = event.target.value;
  renderAdsets();
});
$('statusFilter').addEventListener('change', (event) => {
  adsetState.statuses = event.target.value ? [event.target.value] : [];
  loadAdsets({ reset: true });
});
$('selectAllAdsets').addEventListener('change', (event) => {
  for (const adset of visibleAdsets()) {
    if (event.target.checked) adsetState.selected.add(adset.id);
    else adsetState.selected.delete(adset.id);
  }
  renderAdsets();
});


$('copyResultDetails').addEventListener('click', async () => {
  if (!lastResults) return;
  const ok = await copyText(JSON.stringify(lastResults, null, 2));
  const button = $('copyResultDetails');
  button.textContent = ok ? 'Copied' : 'Copy failed';
  setTimeout(() => {
    button.textContent = 'Copy details';
  }, 1500);
});

$('reloadAfterRun').addEventListener('click', async () => {
  await hardReload();
  resultDialog.close();
});

resultDialog.addEventListener('close', async () => {
  const hasChanges = Array.isArray(lastResults)
    ? lastResults.some((row) => row.success)
    : Boolean(lastResults?.adsetId || lastResults?.campaignId);
  if (!hasChanges) return;
  const { autoRefresh } = await chrome.storage.sync.get({ autoRefresh: true });
  if (!autoRefresh) return;
  await hardReload();
});

$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('footerOptions').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

$('confirmPlacements').addEventListener('click', (event) => {
  if (selectedPlacements().length) return;
  event.preventDefault();
  let message = document.getElementById('placementError');
  if (!message) {
    message = document.createElement('p');
    message.id = 'placementError';
    message.className = 'hint';
    message.style.color = 'var(--danger)';
    message.textContent = 'Tick at least one placement to continue.';
    $('placementList').after(message);
  }
});

// Re-read the tab while the popup is open, because Ads Manager navigates with pushState.
let pollTick = 0;
setInterval(async () => {
  if (state.manual) return;
  try {
    pollTick += 1;
    const tab = await activeTab();
    if (tab?.url) await refreshSelection();
    if (pollTick % 6 === 0) await setSessionHint();
  } catch {
    // Tab or worker went away; the next tick retries.
  }
}, 1500);

(async function init() {
  $('versionLabel').textContent = `v${chrome.runtime.getManifest().version}`;
  const tab = await activeTab();
  if (!tab || !isAdsManager(tab.url)) {
    els.selectionTitle.textContent = 'Open Meta Ads Manager';
    els.selectionSub.textContent = 'This helper only works on adsmanager.facebook.com.';
    $('actions').querySelectorAll('button').forEach((button) => {
      button.disabled = true;
    });
  } else {
    await refreshSelection();
  }
  setSessionHint();
})();

import { ENHANCEMENTS, ENHANCEMENT_COUNT } from '../src/enhancements.js';
import { shortPostId } from '../src/lib/adIds.js';

const LOG_KEY = 'enhancementLog';

const KEYS = [
  'sidebarMode',
  'pdOptimizeWebsiteDestination',
  'pdProductBrowsing',
  'pdBrowserAddons',
  'preserveSocialProof',
  'verifyCreatives',
  'autoRefresh',
];

const status = document.getElementById('status');

function setStatus(text) {
  status.textContent = text;
  if (!text) return;
  setTimeout(() => {
    if (status.textContent === text) status.textContent = '';
  }, 1800);
}

async function restore() {
  const stored = await chrome.storage.sync.get({
    sidebarMode: true,
    pdOptimizeWebsiteDestination: true,
    pdProductBrowsing: true,
    pdBrowserAddons: true,
    preserveSocialProof: true,
    verifyCreatives: true,
    autoRefresh: true,
    concurrency: 2,
  });
  for (const key of KEYS) {
    document.getElementById(key).checked = Boolean(stored[key]);
  }
  document.getElementById('concurrency').value = String(stored.concurrency);
}

document.getElementById('enhancementCount').textContent = String(ENHANCEMENT_COUNT);
const list = document.getElementById('enhancementList');
for (const { key, when } of ENHANCEMENTS) {
  if (when === 'never') continue;
  const li = document.createElement('li');
  li.textContent = when === 'always' ? key : `${key} (catalog only)`;
  list.appendChild(li);
}

for (const key of KEYS) {
  document.getElementById(key).addEventListener('change', async (event) => {
    await chrome.storage.sync.set({ [key]: event.target.checked });
    setStatus('Saved.');
  });
}

document.getElementById('concurrency').addEventListener('change', async (event) => {
  await chrome.storage.sync.set({ concurrency: Number(event.target.value) });
  setStatus('Saved.');
});

document.getElementById('clearToken').addEventListener('click', async () => {
  await chrome.storage.session.remove('fbAccessToken');
  await chrome.storage.local.remove('graphApiVersion');
  setStatus('Session cleared. Reload Ads Manager to connect again.');
});

async function renderLog() {
  const box = document.getElementById('enhancementLog');
  const bag = await chrome.storage.local.get(LOG_KEY);
  const rows = Array.isArray(bag[LOG_KEY]) ? bag[LOG_KEY] : [];
  box.replaceChildren();

  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'sub';
    empty.textContent = 'No enhancement runs recorded yet.';
    box.appendChild(empty);
    return;
  }

  for (const row of rows.slice(0, 100)) {
    const card = document.createElement('div');
    card.className = 'log-row';

    const info = document.createElement('div');
    const when = new Date(row.at).toLocaleString();
    const line1 = document.createElement('div');
    line1.textContent = `${when} · ad ${row.adId}`;
    const line2 = document.createElement('div');
    line2.className = 'meta';

    const post = shortPostId(row.sourcePostId);
    if (post) {
      line2.append('old post ');
      const code = document.createElement('code');
      code.textContent = post;
      line2.append(code, ' → ');
    } else {
      line2.append('no post recorded → ');
    }
    line2.append(`new creative ${row.newCreativeId || '?'} (${row.socialProof || 'unknown'})`);

    info.append(line1, line2);
    card.appendChild(info);

    if (post) {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'secondary';
      copy.textContent = 'Copy post ID';
      copy.addEventListener('click', async () => {
        await navigator.clipboard.writeText(post).catch(() => {});
        copy.textContent = 'Copied';
        setTimeout(() => {
          copy.textContent = 'Copy post ID';
        }, 1200);
      });
      card.appendChild(copy);
    }

    box.appendChild(card);
  }
}

renderLog();

restore();

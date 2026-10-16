// Tripwire app: wires the live feed, the range/filters and the contract lookup to the page.
import { blocksFor, clock, dossier, enrich, headBlock, isAddress, scanRange, Stale } from './core.js';
import { drawSeismo, duration, eventRow, FEED_KINDS, groupEvents, groupRow, h, KINDS, kb, label, short, usd, verdicts } from './view.js';

const RANGES = [
  { id: '1h', seconds: 3600 },
  { id: '6h', seconds: 6 * 3600 },
  { id: '24h', seconds: 86400 },
  { id: '3d', seconds: 3 * 86400 },
];
const POLL_MS = 15_000;
const MAX_ROWS = 400;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const state = {
  range: RANGES.find((r) => r.id === params.get('r')) || RANGES[2],
  kinds: new Set(FEED_KINDS),
  tradedOnly: false,
  events: [],
  info: new Map(),
  clock: null,
  from: 0,
  to: 0,
  scanId: 0,
  loading: false,
  labelling: false,
  failed: false,
  fresh: new Set(),
  dossierId: 0,
};

// ---------- rendering ----------

/** Events known to be real contract changes (not smart wallets, and code swaps only once checked). */
const confirmed = () =>
  state.events.filter((e) => {
    const i = state.info.get(e.address);
    if (i?.wallet) return false;
    // Most raw code swaps are smart wallets: hold them back while the code check runs. If it
    // cannot run, show them anyway rather than hide the most important events.
    return e.kind !== 'code' || Boolean(i) || !state.labelling;
  });

const visible = () =>
  confirmed().filter((e) => state.kinds.has(e.kind) && (!state.tradedOnly || Boolean(state.info.get(e.address)?.market)));

function render() {
  const now = Date.now() / 1000;
  const rows = visible();
  const nonWallet = confirmed();
  drawSeismo($('seismo'), rows, { from: state.from, to: state.to });
  const list = $('events');
  const ctx = { info: state.info, timeOf: state.clock.timeOf, now, onWho: openDossier };
  list.replaceChildren(
    ...groupEvents(rows.slice(0, MAX_ROWS)).map((g) =>
      g.items.length > 1 ? groupRow(g, ctx) : eventRow(g.items[0], { ...ctx, fresh: state.fresh.has(g.items[0]) }),
    ),
  );
  renderChips(nonWallet);
  if (rows.length > MAX_ROWS) list.append(h('li', { class: 'more' }, `Showing the newest ${MAX_ROWS} of ${rows.length}. Narrow the range or filters to see the rest.`));
}

function renderChips(events) {
  const counts = Object.fromEntries(FEED_KINDS.map((k) => [k, 0]));
  for (const e of events) if (counts[e.kind] != null) counts[e.kind]++;
  $('chips').replaceChildren(
    ...FEED_KINDS.map((k) =>
      h(
        'button',
        {
          type: 'button',
          class: `chip ${KINDS[k].level}`,
          'aria-pressed': String(state.kinds.has(k)),
          onclick: () => {
            if (state.kinds.has(k)) state.kinds.delete(k);
            else state.kinds.add(k);
            render();
          },
        },
        h('span', { class: 'dot' }),
        KINDS[k].chip,
        h('b', {}, String(counts[k])),
      ),
    ),
  );
}

function renderRanges() {
  $('ranges').replaceChildren(
    ...RANGES.map((r) =>
      h(
        'button',
        {
          type: 'button',
          role: 'radio',
          'aria-checked': String(r === state.range),
          onclick: () => {
            if (r === state.range) return;
            state.range = r;
            setParam('r', r.id === '24h' ? null : r.id);
            renderRanges();
            load();
          },
        },
        r.id,
      ),
    ),
  );
}

const status = (text) => { $('status').textContent = text; };

function setLive(text, ok = true) {
  $('live-text').textContent = text;
  $('live').classList.toggle('down', !ok);
}

function setParam(key, value) {
  const p = new URLSearchParams(location.search);
  if (value) p.set(key, value);
  else p.delete(key);
  const q = p.toString();
  history.replaceState(null, '', q ? `?${q}` : location.pathname);
}

// ---------- data ----------

const eventKey = (e) => `${e.tx}:${e.index}:${e.address}`;

function addEvents(events, { fresh = false } = {}) {
  const have = new Set(state.events.map(eventKey));
  const added = events.filter((e) => !have.has(eventKey(e)));
  if (!added.length) return;
  if (fresh) added.forEach((e) => state.fresh.add(e));
  state.events = [...state.events, ...added]
    .filter((e) => e.block >= state.from)
    .sort((a, b) => b.block - a.block || b.index - a.index);
  render();
}

/** Label events; a failure leaves them unlabelled (and visible) instead of breaking the feed. */
async function labelEvents(events, id) {
  const isStale = () => id !== state.scanId;
  state.labelling = true;
  try {
    await enrich(events, state.info, (updates) => {
      for (const [a, v] of updates) state.info.set(a, { ...state.info.get(a), ...v });
      saveLabelsSoon();
      if (!isStale()) render();
    }, isStale);
  } catch (err) {
    if (!(err instanceof Stale)) setLive('Labels delayed', false);
  } finally {
    if (!isStale()) {
      state.labelling = false;
      render();
    }
  }
}

// Wallet / symbol / code-size labels never change in practice, so keep them between visits.
// Market data is always fetched fresh and never cached.
const LABELS_KEY = 'tripwire.labels.v2';
const SAVE_DELAY_MS = 2000;
const MAX_CACHED = 5000;

function loadLabels() {
  try {
    const saved = JSON.parse(localStorage.getItem(LABELS_KEY) || '{}');
    for (const [a, v] of Object.entries(saved)) if (v && typeof v === 'object' && v.done) state.info.set(a, v);
  } catch {
    // storage blocked or corrupt: start without the cache
  }
}

let saveTimer = 0;
function saveLabelsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveLabels, SAVE_DELAY_MS);
}

function saveLabels() {
  try {
    const entries = [...state.info]
      .filter(([, v]) => v.done)
      .slice(-MAX_CACHED)
      .map(([a, { market, ...label }]) => [a, label]);
    localStorage.setItem(LABELS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // storage full or blocked: the cache is only a speed-up
  }
}

async function load() {
  const id = ++state.scanId;
  const isStale = () => id !== state.scanId;
  state.events = [];
  state.fresh.clear();
  state.loading = true;
  state.failed = false;
  try {
    status('Reading the chain…');
    const head = await headBlock();
    state.clock = await clock(head);
    state.to = head;
    state.from = Math.max(0, head - blocksFor(state.range.seconds, state.clock.perBlock));
    $('seismo-start').textContent = `${state.range.id} ago`;
    setLive(`Live · block ${head.toLocaleString()}`);
    render();
    state.labelling = true; // hold back unchecked code swaps until labelling has had its go
    await scanRange(state.from, head, (events, progress) => {
      if (isStale()) return;
      status(progress < 1 ? `Scanning ${Math.round(progress * 100)}% of the last ${state.range.id}…` : 'Labelling contracts…');
      addEvents(events);
    }, isStale);
    if (isStale()) return;
    await labelEvents(state.events, id);
    if (id !== state.scanId) return;
    summarize();
  } catch (err) {
    if (isStale() || err instanceof Stale) return;
    state.failed = true;
    state.labelling = false;
    render();
    status(`${err.message} Retrying shortly.`);
    setLive('Offline', false);
  } finally {
    if (id === state.scanId) state.loading = false;
  }
}

function summarize() {
  const shown = visible().length;
  const wallets = state.events.filter((e) => state.info.get(e.address)?.wallet).length;
  status(
    `${shown} rule change${shown === 1 ? '' : 's'} in the last ${state.range.id}` +
      (wallets ? ` · ${wallets} smart-wallet upgrades hidden` : '') +
      ' · watching for new ones',
  );
}

let polling = false;
async function poll() {
  if (polling || state.loading || document.hidden) return;
  if (state.failed || !state.clock) return load(); // the last load failed: start over
  polling = true;
  const id = state.scanId;
  const isStale = () => id !== state.scanId;
  try {
    const head = await headBlock();
    if (head <= state.to || isStale()) return;
    const found = [];
    await scanRange(state.to + 1, head, (events) => found.push(...events), isStale);
    const nextClock = await clock(head);
    if (isStale()) return;
    // only move the window forward once the new blocks were actually read
    state.clock = nextClock;
    state.to = head;
    setLive(`Live · block ${head.toLocaleString()}`);
    if (found.length) {
      addEvents(found, { fresh: true });
      await labelEvents(found, id);
    }
    if (!isStale() && !state.loading) summarize();
  } catch {
    setLive('Reconnecting', false);
  } finally {
    polling = false;
  }
}

// ---------- contract lookup ----------

async function openDossier(address) {
  const myId = ++state.dossierId;
  const isCurrent = () => myId === state.dossierId;
  const box = $('dossier');
  $('check-input').value = address;
  setParam('a', address.toLowerCase());
  box.hidden = false;
  const loading = h('p', { class: 'loading' }, `Reading ${short(address)} back to launch…`);
  box.replaceChildren(loading);
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const d = await dossier(address, (p) => {
      if (isCurrent()) loading.textContent = `Reading ${short(address)} back to launch… ${Math.round(p * 100)}%`;
    });
    const c = state.clock || (await clock(d.head));
    if (isCurrent()) renderDossier(d, c);
  } catch (err) {
    if (isCurrent()) box.replaceChildren(h('p', { class: 'error' }, err.message));
  }
}

function renderDossier({ state: s, market, events, complete, oldest }, c) {
  const box = $('dossier');
  const info = new Map([[s.address, { symbol: s.symbol || market?.symbol }]]); // no per-row mcap: it is in the header
  const now = Date.now() / 1000;
  const title = market?.name || s.name || label(s.address, info.get(s.address));
  const changes = events.filter((e) => !e.atDeploy);
  const launch = events.filter((e) => e.atDeploy).at(-1);
  const firstChange = changes.at(-1);
  const speed = launch && firstChange ? c.timeOf(firstChange.block) - c.timeOf(launch.block) : null;
  const scope = complete || launch ? 'since launch' : `since block ${oldest.toLocaleString()}`;
  box.replaceChildren(
    h('div', { class: 'd-head' },
      h('div', {},
        h('p', { class: 'd-sym' }, s.symbol || market?.symbol || 'Contract'),
        h('h3', {}, title),
        h('p', { class: 'd-addr' }, s.address),
      ),
      h('div', { class: 'd-facts' },
        market ? h('span', {}, h('b', {}, usd(market.marketCap)), ' mcap') : null,
        market ? h('span', {}, h('b', {}, usd(market.liquidity)), ' liquidity') : null,
        s.size ? h('span', {}, h('b', {}, kb(s.size)), ' code') : null,
        h('span', {}, h('b', {}, String(changes.length)), ` rule change${changes.length === 1 ? '' : 's'} ${scope}`),
      ),
      h('button', { type: 'button', class: 'd-close', 'aria-label': 'Close', onclick: closeDossier }, '×'),
    ),
    speed != null
      ? h('p', { class: 'd-alert', 'data-level': speed < 3600 ? 'high' : 'mid' },
          'Rules first changed ', h('b', {}, duration(speed)), ' after launch.')
      : null,
    h('ul', { class: 'verdicts' },
      ...verdicts(s).map((v) => h('li', { 'data-level': v.level }, h('span', { class: 'v-text' }, v.text), v.detail ? h('span', { class: 'v-detail' }, ...v.detail) : null)),
    ),
    events.length
      ? h('ol', { class: 'events timeline' },
          ...events.map((e) => eventRow(e, { info, timeOf: c.timeOf, now })),
        )
      : h('p', { class: 'quiet' }, 'No ownership, upgrade or pause events on record. Its rules have never changed.'),
  );
}

function closeDossier() {
  state.dossierId++;
  $('dossier').hidden = true;
  setParam('a', null);
}

$('check-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const v = $('check-input').value.trim();
  if (!isAddress(v)) {
    $('check-hint').textContent = 'That is not a valid address. It should be 0x followed by 40 hex characters.';
    $('check-hint').classList.add('bad');
    return;
  }
  $('check-hint').classList.remove('bad');
  openDossier(v);
});

$('traded-only').addEventListener('change', (ev) => {
  state.tradedOnly = ev.target.checked;
  render();
  if (!state.loading) summarize();
});

loadLabels();
renderRanges();
load();
setInterval(poll, POLL_MS);
setInterval(() => state.clock && render(), 30_000); // keep "x ago" honest
document.addEventListener('visibilitychange', poll);
const start = params.get('a');
if (start && isAddress(start)) openDossier(start);

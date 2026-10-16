// Tripwire view helpers: formatting and DOM builders. All text goes in via textContent.
import { EXPLORER } from './core.js';

export const KINDS = {
  code: { tag: 'Code swapped', level: 'high', chip: 'Code swaps' },
  admin: { tag: 'Admin moved', level: 'high', chip: 'Admin moves' },
  pause: { tag: 'Paused', level: 'high', chip: 'Pauses' },
  owner: { tag: 'Owner changed', level: 'mid', chip: 'Owner changes' },
  unpause: { tag: 'Unpaused', level: 'mid', chip: 'Unpauses' },
  renounce: { tag: 'Renounced', level: 'low', chip: 'Renounces' },
  // Lookup-only kinds (launch-time setup)
  created: { tag: 'Launched', level: 'note' },
  beacon: { tag: 'Beacon set', level: 'note' },
};
/** Labels for setup that happened in the launch transaction itself. */
const AT_LAUNCH = { code: 'Initial code', admin: 'Initial admin', owner: 'Initial owner', created: 'Launched', beacon: 'Beacon set' };

export const FEED_KINDS = ['code', 'admin', 'pause', 'owner', 'unpause', 'renounce'];

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');

export function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export const ago = (seconds) => `${duration(seconds)} ago`;

export function usd(n) {
  if (!n) return '$0';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

export const kb = (bytes) => (bytes == null ? '' : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`);

const addrLink = (a, label = short(a)) =>
  h('a', { href: `${EXPLORER}/address/${a}`, target: '_blank', rel: 'noopener', class: 'addr', title: a }, label);

/** The one-line human sentence for an event. */
export function sentence(e, info) {
  const t = info.get(e.target);
  switch (e.kind) {
    case 'code':
      if (e.atDeploy) return ['Started out running code from ', addrLink(e.target)];
      return ['Implementation replaced with ', addrLink(e.target), t?.size ? ` (${kb(t.size)} of new code)` : t && t.size === 0 ? ' (no code there)' : ''];
    case 'admin':
      return ['Upgrade control moved from ', addrLink(e.from), ' to ', addrLink(e.target)];
    case 'owner':
      return ['Ownership handed from ', addrLink(e.from), ' to ', addrLink(e.target)];
    case 'renounce':
      return ['Owner ', addrLink(e.from), ' gave up control for good'];
    case 'pause':
      return ['Contract paused', e.from ? [' by ', addrLink(e.from)] : ''];
    case 'unpause':
      return ['Contract unpaused', e.from ? [' by ', addrLink(e.from)] : ''];
    case 'created':
      return ['Launched with owner ', addrLink(e.target)];
    case 'beacon':
      return ['Built as a beacon proxy reading code from ', addrLink(e.target)];
    default:
      return [];
  }
}

export const label = (address, i) => i?.market?.symbol || i?.symbol || short(address);

/** One feed row. `onWho` opens the lookup for that contract. */
export function eventRow(e, { info, timeOf, now, onWho, fresh = false }) {
  const i = info.get(e.address);
  const k = KINDS[e.kind];
  const row = document.getElementById('row-tpl').content.firstElementChild.cloneNode(true);
  row.dataset.level = e.atDeploy ? 'note' : k.level;
  if (fresh) row.classList.add('fresh');
  const t = timeOf(e.block);
  row.querySelector('.when').textContent = ago(now - t);
  row.querySelector('.when').dateTime = new Date(t * 1000).toISOString();
  row.querySelector('.tag').textContent = e.atDeploy ? AT_LAUNCH[e.kind] || k.tag : k.tag;
  const who = row.querySelector('.who');
  who.textContent = label(e.address, i);
  // symbols are self-declared: always show which contract it really is
  if (who.textContent !== short(e.address)) who.append(h('span', { class: 'who-addr' }, short(e.address)));
  who.title = `Check ${e.address}`;
  if (onWho) who.addEventListener('click', () => onWho(e.address));
  else who.disabled = true;
  const mcap = row.querySelector('.mcap');
  if (i?.market) mcap.textContent = `${usd(i.market.marketCap)} mcap`;
  else mcap.remove();
  row.querySelector('.line').append(...sentence(e, info).flat());
  const links = row.querySelector('.links');
  links.append(h('a', { href: `${EXPLORER}/tx/${e.tx}`, target: '_blank', rel: 'noopener' }, 'tx ↗'));
  if (i?.market?.url) links.append(h('a', { href: i.market.url, target: '_blank', rel: 'noopener' }, 'chart ↗'));
  return row;
}

const GROUP_GAP_BLOCKS = 36_000; // ~1h at 0.1s blocks

/**
 * Collapse runs of the same change made by the same keys across many contracts
 * (an operator rotating ownership of a whole fleet) into one group.
 */
export function groupEvents(events) {
  const out = [];
  for (const e of events) {
    const last = out.at(-1);
    const same =
      last &&
      last.kind === e.kind &&
      last.from === e.from &&
      last.target === e.target &&
      (e.from || e.target) &&
      last.items.at(-1).block - e.block <= GROUP_GAP_BLOCKS &&
      !last.items.some((x) => x.address === e.address);
    if (same) last.items.push(e);
    else out.push({ kind: e.kind, from: e.from, target: e.target, items: [e] });
  }
  return out;
}

/** A row standing for several contracts that changed the same way in one burst. */
export function groupRow(g, { info, timeOf, now, onWho }) {
  const [first] = g.items;
  const row = eventRow(first, { info, timeOf, now, onWho });
  row.classList.add('group');
  const who = row.querySelector('.who');
  who.replaceWith(h('span', { class: 'count' }, `${g.items.length} contracts`));
  row.querySelector('.mcap')?.remove();
  const oldest = timeOf(g.items.at(-1).block);
  row.querySelector('.when').textContent = `${ago(now - timeOf(first.block))}`;
  row.querySelector('.when').title = `Burst spans back to ${ago(now - oldest)}`;
  row.querySelector('.what').append(
    h('div', { class: 'members' },
      ...g.items.map((e) =>
        h('button', { type: 'button', class: 'member', title: `Check ${e.address}`, onclick: () => onWho?.(e.address) },
          label(e.address, info.get(e.address)),
          info.get(e.address)?.market ? h('i', {}, usd(info.get(e.address).market.marketCap)) : null,
        ),
      ),
    ),
  );
  return row;
}

/** Bars of event counts across the range, coloured by the worst event in each bucket. */
export function drawSeismo(svg, events, { from, to, buckets = 96 }) {
  const W = 960;
  const H = 72;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.replaceChildren();
  const span = Math.max(1, to - from);
  const counts = Array.from({ length: buckets }, () => ({ n: 0, level: 'low' }));
  const rank = { low: 0, mid: 1, high: 2 };
  for (const e of events) {
    const b = Math.min(buckets - 1, Math.max(0, Math.floor(((e.block - from) / span) * buckets)));
    const lvl = KINDS[e.kind].level;
    counts[b].n++;
    if (rank[lvl] > rank[counts[b].level]) counts[b].level = lvl;
  }
  const max = Math.max(1, ...counts.map((c) => c.n));
  const bw = W / buckets;
  const ns = 'http://www.w3.org/2000/svg';
  const base = document.createElementNS(ns, 'line');
  Object.entries({ x1: 0, x2: W, y1: H / 2, y2: H / 2, class: 'seismo-wire' }).forEach(([k, v]) => base.setAttribute(k, v));
  svg.append(base);
  counts.forEach((c, k) => {
    if (!c.n) return;
    const amp = Math.max(4, (Math.sqrt(c.n) / Math.sqrt(max)) * (H / 2 - 2));
    const r = document.createElementNS(ns, 'rect');
    Object.entries({ x: k * bw + 1, y: H / 2 - amp, width: Math.max(1, bw - 2), height: amp * 2, rx: 1, class: `bar ${c.level}` })
      .forEach(([key, v]) => r.setAttribute(key, v));
    const title = document.createElementNS(ns, 'title');
    title.textContent = `${c.n} change${c.n === 1 ? '' : 's'}`;
    r.append(title);
    svg.append(r);
  });
}

/** Plain-English read of a contract's current control state. */
export function verdicts(s) {
  const out = [];
  if (s.wallet) return [{ level: 'note', text: 'This is a smart wallet (EIP-7702), not a contract.' }];
  if (!s.size) return [{ level: 'note', text: 'No contract code at this address.' }];
  if (s.implementation) out.push({ level: 'high', text: 'Upgradeable: its code can be replaced.', detail: ['Runs code from ', addrLink(s.implementation)] });
  else if (s.beacon) out.push({ level: 'high', text: 'Upgradeable through a beacon.', detail: ['Beacon ', addrLink(s.beacon)] });
  else out.push({ level: 'low', text: 'Fixed code: no proxy slot set.' });
  if (s.admin) out.push({ level: 'mid', text: 'Has an upgrade admin.', detail: [addrLink(s.admin)] });
  if (s.owner && /^0x0{36}(0{4}|dead)$/.test(s.owner)) out.push({ level: 'low', text: 'Ownership renounced.' });
  else if (s.owner) out.push({ level: 'mid', text: 'Has an owner.', detail: [addrLink(s.owner)] });
  else out.push({ level: 'low', text: 'No owner() function.' });
  if (s.paused === true) out.push({ level: 'high', text: 'Paused right now.' });
  else if (s.paused === false) out.push({ level: 'mid', text: 'Pausable, currently running.' });
  return out;
}

// Tripwire core: reads rule-change events straight from the Robinhood Chain public RPC.
import { ALL_TOPICS, classifyLogs, decodeString, isDelegatedWallet, windowsFor, ZERO } from './classify.js';

export const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
export const EXPLORER = 'https://robinhoodchain.blockscout.com';
const FEED_RANGE = 30_000; // max blocks per chain-wide eth_getLogs (no address filter)
const ADDRESS_RANGE = 10_000_000; // max blocks per eth_getLogs with an address filter
const BATCH_SIZE = 10; // calls per JSON-RPC batch (the RPC rejects ~25+)
const LOGS_BATCH = 3; // chain-wide log windows are ~250 KB each, keep responses small
const BATCH_CONCURRENCY = 2;
const DEX_BATCH = 30; // DexScreener tokens/v1 takes up to 30 addresses
const RATE_SAMPLE = 100_000; // blocks used to measure block time
const HISTORY_PARALLEL = 2; // 10M-block windows read at once in a lookup

const SEL = { owner: '0x8da5cb5b', paused: '0x5c975abb', name: '0x06fdde03', symbol: '0x95d89b41' };
const SLOT = {
  implementation: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
};

export const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s).trim());
const hex = (n) => '0x' + n.toString(16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BUSY = 'The Robinhood Chain RPC is busy. Wait a few seconds and try again.';
// Only the RPC's "too many logs in this window" errors justify splitting a window in half.
const TOO_MANY = /logs matched by query exceeds limit|more than 10000|query returned more than/i;
const MAX_SPLIT_DEPTH = 8;
const FETCH_TIMEOUT_MS = 20_000;
const ATTEMPTS = 6;
export class Stale extends Error {}

// One shared throttle for every request: the public RPC answers bursts with a Cloudflare page whose
// broken CORS header ('*,*') makes browsers fail the fetch, so pace calls and cool down together.
const MAX_INFLIGHT = 3; // slow log queries can overlap; MIN_GAP_MS alone caps the call rate
const MIN_GAP_MS = 1000; // sustained budget is ~10 calls/s (token bucket); 10-call batches once a second stay under it
let inflight = 0;
let nextSlot = 0;
let coolUntil = 0;
const waiters = [];

/** Wait for a request slot. Urgent requests (a contract lookup someone is waiting on) jump the queue. */
async function acquire(urgent) {
  // A released slot is handed straight to the next waiter, so newcomers can never overtake the queue.
  if (inflight >= MAX_INFLIGHT) await new Promise((r) => (urgent ? waiters.unshift(r) : waiters.push(r)));
  else inflight++;
  for (;;) {
    const now = Date.now();
    const at = Math.max(now, nextSlot, coolUntil);
    if (at <= now) break;
    await sleep(at - now); // re-check: a failure elsewhere may have pushed coolUntil while we slept
  }
  nextSlot = Date.now() + MIN_GAP_MS;
}

function release() {
  const next = waiters.shift();
  if (next) next();
  else inflight--;
}

/** POST a JSON-RPC payload, backing off when the public RPC rate-limits (429 / Cloudflare page). */
async function post(payload, urgent = false) {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    await acquire(urgent);
    let retriable = true;
    try {
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const text = await res.text();
      const isJson = text.startsWith('{') || text.startsWith('[');
      if (isJson && res.status !== 429 && res.status < 500) return JSON.parse(text);
      retriable = res.status === 429 || res.status >= 500 || !isJson; // non-JSON = Cloudflare page
      if (!retriable) throw new Error(`The Robinhood Chain RPC answered ${res.status}.`);
    } catch (err) {
      // blocked by the broken CORS header, timed out, or a network blip: cool down and retry
      if (!retriable) throw err;
    } finally {
      release();
    }
    if (attempt < ATTEMPTS - 1) coolUntil = Math.max(coolUntil, Date.now() + 1500 * 2 ** attempt);
  }
  throw new Error(BUSY);
}

let rpcId = 0;
export async function rpc(method, params, urgent = false) {
  const json = await post({ jsonrpc: '2.0', id: ++rpcId, method, params }, urgent);
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

/** Run fn over items with a few workers; stops handing out work after a failure or once stale. */
async function pool(items, limit, fn, isStale = () => false) {
  const out = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < items.length && !failed) {
      if (isStale()) throw new Stale();
      const k = next++;
      try {
        out[k] = await fn(items[k], k);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Run many calls as JSON-RPC batches. Failed calls come back as Error values (never thrown). */
async function rpcMany(calls, onBatch = () => {}, { size = BATCH_SIZE, urgent = false, isStale } = {}) {
  const batches = [];
  for (let i = 0; i < calls.length; i += size) batches.push(calls.slice(i, i + size));
  const results = await pool(batches, BATCH_CONCURRENCY, async (batch, k) => {
    const payload = batch.map(([method, params]) => ({ jsonrpc: '2.0', id: ++rpcId, method, params }));
    const json = await post(payload, urgent);
    const byId = new Map((Array.isArray(json) ? json : [json]).map((r) => [r.id, r]));
    const out = payload.map((p) => {
      const r = byId.get(p.id);
      if (!r) return new Error(BUSY);
      return r.error ? new Error(`${p.method}: ${r.error.message}`) : r.result;
    });
    await onBatch(out, k * size);
    return out;
  }, isStale);
  return results.flat();
}

export async function headBlock() {
  return parseInt(await rpc('eth_blockNumber', []), 16);
}

/** A block→time estimator anchored on the head block and the measured average block time. */
export async function clock(head) {
  const [now, past] = await rpcMany([
    ['eth_getBlockByNumber', [hex(head), false]],
    ['eth_getBlockByNumber', [hex(Math.max(0, head - RATE_SAMPLE)), false]],
  ]);
  if (now instanceof Error || past instanceof Error) throw new Error(BUSY);
  const t1 = parseInt(now.timestamp, 16);
  const t0 = parseInt(past.timestamp, 16);
  const perBlock = Math.max(0.01, (t1 - t0) / Math.min(head, RATE_SAMPLE));
  return { head, headTime: t1, perBlock, timeOf: (block) => t1 - (head - block) * perBlock };
}

export const blocksFor = (seconds, perBlock) => Math.ceil(seconds / perBlock);

const logFilter = (from, to, extra = {}) => ({ fromBlock: hex(from), toBlock: hex(to), topics: [ALL_TOPICS], ...extra });

/** Fetch one window, halving it whenever the RPC says it holds too many logs. */
async function logsSplit(from, to, extra, urgent = false, depth = 0) {
  try {
    return await rpc('eth_getLogs', [logFilter(from, to, extra)], urgent);
  } catch (err) {
    if (!TOO_MANY.test(err.message) || depth >= MAX_SPLIT_DEPTH || to <= from) throw err;
    const mid = Math.floor((from + to) / 2);
    return [...(await logsSplit(from, mid, extra, urgent, depth + 1)), ...(await logsSplit(mid + 1, to, extra, urgent, depth + 1))];
  }
}

/**
 * Chain-wide scan of [from, to], newest window first. Calls onWindow(events, progress) as each
 * window lands so the UI can paint before the whole range is in.
 */
export async function scanRange(from, to, onWindow = () => {}, isStale) {
  const windows = windowsFor(to, from, FEED_RANGE);
  let done = 0;
  await rpcMany(
    windows.map(([f, t]) => ['eth_getLogs', [logFilter(f, t)]]),
    async (results, offset) => {
      for (let i = 0; i < results.length; i++) {
        let logs = results[i];
        if (logs instanceof Error) {
          if (!TOO_MANY.test(logs.message)) throw logs;
          const [f, t] = windows[offset + i];
          logs = await logsSplit(f, t);
        }
        done++;
        onWindow(classifyLogs(logs), done / windows.length);
      }
    },
    { size: LOGS_BATCH, isStale },
  );
}

const unique = (xs) => [...new Set(xs.filter(Boolean))];
const codeSize = (code) => (typeof code === 'string' ? (code.length - 2) / 2 : null);

/** eth_getCode for many addresses; failed reads come back as null. */
async function codesOf(addresses, isStale) {
  const codes = await rpcMany(addresses.map((a) => ['eth_getCode', [a, 'latest']]), undefined, { isStale });
  return new Map(addresses.map((a, i) => [a, codes[i] instanceof Error ? null : codes[i]]));
}

/**
 * Label the contracts behind events, most useful first, within the RPC's small call budget:
 * 1. wallet check for code swaps, reading one address per new implementation (EIP-7702 wallets
 *    all delegate to a handful of wallet implementations), 2. symbol() of real contracts,
 * 3. DexScreener markets, 4. size of each new implementation.
 * Only successful reads become labels, and only finished labels carry done: true, so a failed or
 * interrupted run is retried next time. `known` holds earlier labels; onInfo(updates) gets a Map
 * of address → partial label as each step lands.
 */
export async function enrich(events, known, onInfo = () => {}, isStale) {
  const seen = new Set([...known].filter(([, v]) => v.done).map(([a]) => a)); // snapshot
  const isNew = (a) => a && !seen.has(a);

  const byTarget = new Map();
  for (const e of events) {
    if (e.kind === 'code' && isNew(e.address)) byTarget.set(e.target, unique([...(byTarget.get(e.target) || []), e.address]));
  }
  const repCodes = await codesOf([...byTarget.values()].map((addrs) => addrs[0]), isStale);
  const walletOf = new Map();
  for (const addrs of byTarget.values()) {
    const code = repCodes.get(addrs[0]);
    if (code == null) continue; // read failed: leave unlabelled so the next run retries
    for (const a of addrs) walletOf.set(a, isDelegatedWallet(code));
  }
  if (walletOf.size) onInfo(new Map([...walletOf].map(([a, wallet]) => [a, wallet ? { wallet, done: true } : { wallet }])));

  const contracts = unique(events.map((e) => e.address)).filter((a) => isNew(a) && walletOf.get(a) !== true);
  const symbols = await rpcMany(contracts.map((a) => ['eth_call', [{ to: a, data: SEL.symbol }, 'latest']]), undefined, { isStale });
  const symbolOf = new Map();
  contracts.forEach((a, i) => {
    const r = symbols[i];
    if (!(r instanceof Error)) symbolOf.set(a, decodeString(r));
    else if (/revert/i.test(r.message)) symbolOf.set(a, null); // a real answer: no symbol()
  });
  if (symbolOf.size) onInfo(new Map([...symbolOf].map(([a, symbol]) => [a, { wallet: false, symbol, done: true }])));

  const tokens = unique(events.map((e) => e.address)).filter((a) => symbolOf.get(a) || known.get(a)?.symbol);
  const markets = await dexMarkets(tokens);
  if (markets.size) onInfo(new Map([...markets].map(([a, market]) => [a, { market }])));

  const targets = unique(events.filter((e) => e.kind === 'code' && walletOf.get(e.address) === false).map((e) => e.target)).filter(isNew);
  const targetCodes = await codesOf(targets, isStale);
  const sized = targets.filter((a) => targetCodes.get(a) != null);
  if (sized.length) onInfo(new Map(sized.map((a) => [a, { size: codeSize(targetCodes.get(a)), done: true }])));
}

/** Best (deepest) DexScreener pair per token, keyed by lowercase address. Never throws. */
export async function dexMarkets(tokens) {
  const out = new Map();
  for (let i = 0; i < tokens.length; i += DEX_BATCH) {
    const chunk = tokens.slice(i, i + DEX_BATCH);
    try {
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${chunk.join(',')}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const pairs = await res.json();
      for (const p of Array.isArray(pairs) ? pairs : []) {
        const a = String(p.baseToken?.address || '').toLowerCase();
        const prev = out.get(a);
        if (!chunk.includes(a) || (prev && prev.liquidity >= (p.liquidity?.usd || 0))) continue;
        out.set(a, {
          name: p.baseToken?.name || null,
          symbol: p.baseToken?.symbol || null,
          marketCap: Number(p.marketCap || p.fdv || 0),
          liquidity: Number(p.liquidity?.usd || 0),
          url: typeof p.url === 'string' && p.url.startsWith('https://dexscreener.com/') ? p.url : null,
        });
      }
    } catch {
      // market data is a bonus; the feed stands without it
    }
  }
  return out;
}

const slotAddr = (v) => {
  if (typeof v !== 'string' || v.length < 42) return null;
  const a = '0x' + v.slice(-40).toLowerCase();
  return a === ZERO ? null : a;
};

/** Everything Tripwire knows about one contract: current control state plus its full change history. */
export async function dossier(address, onProgress = () => {}) {
  const a = address.trim().toLowerCase();
  const [blockNumber, code, impl, admin, beacon, owner, paused, name, symbol] = await rpcMany([
    ['eth_blockNumber', []],
    ['eth_getCode', [a, 'latest']],
    ['eth_getStorageAt', [a, SLOT.implementation, 'latest']],
    ['eth_getStorageAt', [a, SLOT.admin, 'latest']],
    ['eth_getStorageAt', [a, SLOT.beacon, 'latest']],
    ['eth_call', [{ to: a, data: SEL.owner }, 'latest']],
    ['eth_call', [{ to: a, data: SEL.paused }, 'latest']],
    ['eth_call', [{ to: a, data: SEL.name }, 'latest']],
    ['eth_call', [{ to: a, data: SEL.symbol }, 'latest']],
  ], undefined, { urgent: true });
  if (blockNumber instanceof Error) throw blockNumber;
  if (code instanceof Error) throw code;
  const head = parseInt(blockNumber, 16);
  const ok = (v) => (v instanceof Error || v === '0x' ? null : v);
  const state = {
    address: a,
    size: (code.length - 2) / 2,
    wallet: isDelegatedWallet(code),
    implementation: slotAddr(ok(impl)),
    admin: slotAddr(ok(admin)),
    beacon: slotAddr(ok(beacon)),
    owner: ok(owner) && ok(owner).length === 66 ? '0x' + ok(owner).slice(-40).toLowerCase() : null,
    paused: ok(paused) && ok(paused).length === 66 ? BigInt(ok(paused)) !== 0n : null,
    name: decodeString(ok(name)),
    symbol: decodeString(ok(symbol)),
  };

  // With an address filter the RPC allows 10M blocks, but only with one topic per query.
  // Walk back newest-first, a couple of windows at a time, and stop once the launch is in view.
  const windows = windowsFor(head, 0, ADDRESS_RANGE);
  const logs = [];
  let checked = 0;
  for (let i = 0; i < windows.length; i += HISTORY_PARALLEL) {
    const slice = windows.slice(i, i + HISTORY_PARALLEL);
    const found = await Promise.all(slice.map(([f, t]) => windowLogs(a, f, t)));
    logs.push(...found.flat());
    checked += slice.length;
    onProgress(checked / windows.length);
    if (classifyLogs(logs, { keepDeploys: true }).some((e) => e.atDeploy)) break;
  }
  const market = (await dexMarkets([a])).get(a) || null;
  const oldest = windows[checked - 1][0];
  return { state, market, head, complete: checked === windows.length, oldest, events: classifyLogs(logs, { keepDeploys: true }) };
}

/** Every tracked event of one contract inside [from, to], one topic per query. */
async function windowLogs(address, from, to) {
  const extras = ALL_TOPICS.map((topic) => ({ address, topics: [topic] }));
  const results = await rpcMany(
    extras.map((extra) => ['eth_getLogs', [logFilter(from, to, extra)]]),
    undefined,
    { urgent: true, size: ALL_TOPICS.length },
  );
  const out = [];
  for (let i = 0; i < results.length; i++) {
    if (!(results[i] instanceof Error)) out.push(...results[i]);
    else if (TOO_MANY.test(results[i].message)) out.push(...(await logsSplit(from, to, extras[i], true)));
    else throw results[i];
  }
  return out;
}

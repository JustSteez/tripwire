// Tripwire classifier: turns raw event logs into "the rules of this contract changed" events.
// Pure functions only, so it runs the same in the browser and under node --test.

export const TOPICS = {
  UPGRADED: '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b', // Upgraded(address)
  BEACON_UPGRADED: '0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e', // BeaconUpgraded(address)
  ADMIN_CHANGED: '0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f', // AdminChanged(address,address)
  OWNERSHIP: '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0', // OwnershipTransferred(address,address)
  PAUSED: '0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258', // Paused(address)
  UNPAUSED: '0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa', // Unpaused(address)
};

export const ALL_TOPICS = Object.values(TOPICS);
export const ZERO = '0x' + '0'.repeat(40);
const DELEGATION_PREFIX = '0xef0100'; // EIP-7702: an EOA pointing at wallet code

const addrFromWord = (w) => (w && w.length >= 66 ? '0x' + w.slice(-40).toLowerCase() : null);
const dataWord = (data, i) => {
  const hex = (data || '0x').slice(2);
  const w = hex.slice(i * 64, i * 64 + 64);
  return w.length === 64 ? '0x' + w : null;
};
const isZero = (a) => a === ZERO;
const DEAD = '0x000000000000000000000000000000000000dead';
const isBurn = (a) => a === ZERO || a === DEAD;

/** True when the bytes at an address are an EIP-7702 delegation, i.e. a wallet, not a contract. */
export const isDelegatedWallet = (code) => typeof code === 'string' && code.toLowerCase().startsWith(DELEGATION_PREFIX);

/** Split [from, to] into windows of at most `size` blocks, newest first. */
export function windowsFor(to, from, size) {
  const out = [];
  for (let hi = to; hi >= from; hi -= size) out.push([Math.max(from, hi - size + 1), hi]);
  return out;
}

/** Decode a name()/symbol() return value: ABI string or bytes32. Returns null when unreadable. */
export function decodeString(hex) {
  if (typeof hex !== 'string' || hex.length < 66) return null;
  const body = hex.slice(2);
  let bytes;
  if (body.length >= 128 && BigInt('0x' + body.slice(0, 64)) === 32n) {
    const len = Number(BigInt('0x' + body.slice(64, 128)));
    if (len > 64 || body.length < 128 + len * 2) return null;
    bytes = body.slice(128, 128 + len * 2);
  } else {
    bytes = body.slice(0, 64).replace(/(00)+$/, '');
  }
  const raw = new Uint8Array((bytes.match(/../g) || []).map((b) => parseInt(b, 16)));
  const text = new TextDecoder('utf-8').decode(raw);
  // drop control characters and bidi overrides that could disguise a name
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '').trim();
  return clean.length ? clean.slice(0, 40) : null;
}

/** Read one log into a raw change, or null if it is not one we track / is malformed. */
function readLog(l) {
  const t = l.topics || [];
  const base = {
    address: String(l.address).toLowerCase(),
    tx: l.transactionHash,
    block: parseInt(l.blockNumber, 16),
    index: parseInt(l.logIndex, 16) || 0,
  };
  switch (t[0]) {
    case TOPICS.UPGRADED:
      return t[1] ? { ...base, kind: 'code', target: addrFromWord(t[1]) } : null;
    case TOPICS.BEACON_UPGRADED:
      // BeaconProxy can only set its beacon in the constructor, so this always marks a deploy.
      return t[1] ? { ...base, kind: 'beacon', target: addrFromWord(t[1]), created: true } : null;
    case TOPICS.ADMIN_CHANGED: {
      const from = addrFromWord(dataWord(l.data, 0));
      const target = addrFromWord(dataWord(l.data, 1));
      if (!from || !target) return null;
      return { ...base, kind: 'admin', from, target, created: isZero(from) };
    }
    case TOPICS.OWNERSHIP: {
      const from = addrFromWord(t[1]);
      const target = addrFromWord(t[2]);
      if (!from || !target) return null;
      if (isZero(from)) return { ...base, kind: 'created', target, created: true };
      return { ...base, kind: isBurn(target) ? 'renounce' : 'owner', from, target };
    }
    case TOPICS.PAUSED:
    case TOPICS.UNPAUSED: {
      const from = addrFromWord(t[1] || dataWord(l.data, 0));
      return { ...base, kind: t[0] === TOPICS.PAUSED ? 'pause' : 'unpause', from };
    }
    default:
      return null;
  }
}

/**
 * Classify logs into change events, newest first.
 * A tx is a contract's launch when it carries a constructor-style marker for that contract
 * (ownership minted from zero, first admin set, beacon set) AND it is the earliest tx with any
 * tracked log for that contract in this batch, so a later upgrade cannot pass itself off as a
 * launch by emitting a marker. Launch events are dropped unless keepDeploys is set (then they
 * come back with atDeploy: true).
 */
export function classifyLogs(logs, { keepDeploys = false } = {}) {
  const raw = logs.map(readLog).filter(Boolean);
  const firstTx = new Map();
  for (const r of raw) {
    const prev = firstTx.get(r.address);
    if (!prev || r.block < prev.block || (r.block === prev.block && r.index < prev.index)) firstTx.set(r.address, r);
  }
  const deploying = new Set(
    raw.filter((r) => r.created && firstTx.get(r.address).tx === r.tx).map((r) => `${r.tx}:${r.address}`),
  );
  const out = [];
  for (const r of raw) {
    const atDeploy = deploying.has(`${r.tx}:${r.address}`);
    if (atDeploy && !keepDeploys) continue;
    if (r.kind === 'created' && !keepDeploys) continue;
    const { created, ...event } = r;
    out.push(keepDeploys ? { ...event, atDeploy } : event);
  }
  return out.sort((a, b) => b.block - a.block || b.index - a.index);
}

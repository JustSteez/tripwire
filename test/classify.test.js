import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLogs, TOPICS, isDelegatedWallet, decodeString, windowsFor } from '../classify.js';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const C = '0x' + 'c'.repeat(40);
const ZERO = '0x' + '0'.repeat(40);
const word = (addr) => '0x' + '0'.repeat(24) + addr.slice(2);
const num = (n) => '0x' + n.toString(16).padStart(64, '0');

let seq = 0;
const log = (topics, { address = A, data = '0x', tx = '0x01', block = 100 } = {}) => ({
  address,
  topics,
  data,
  transactionHash: tx,
  blockNumber: '0x' + block.toString(16),
  logIndex: '0x' + (seq++).toString(16),
});

test('a lone Upgraded log is a code swap pointing at the new implementation', () => {
  const events = classifyLogs([log([TOPICS.UPGRADED, word(B)])]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'code');
  assert.equal(events[0].address, A);
  assert.equal(events[0].target, B);
  assert.equal(events[0].block, 100);
});

test('Upgraded in the same tx as an ownership mint is a deploy, not a swap', () => {
  const events = classifyLogs([
    log([TOPICS.UPGRADED, word(B)], { tx: '0x02' }),
    log([TOPICS.OWNERSHIP, word(ZERO), word(C)], { tx: '0x02' }),
  ]);
  assert.deepEqual(events, []);
});

test('a launch marker in a later tx cannot hide that upgrade', () => {
  const events = classifyLogs([
    log([TOPICS.OWNERSHIP, word(ZERO), word(C)], { tx: '0x03', block: 10 }),
    log([TOPICS.UPGRADED, word(B)], { tx: '0x04', block: 20 }),
    log([TOPICS.ADMIN_CHANGED], { tx: '0x04', block: 20, data: word(ZERO) + word(C).slice(2) }),
  ]);
  assert.deepEqual(events.map((e) => e.kind).sort(), ['admin', 'code']);
});

test('deploy detection is scoped to the same contract in the same tx', () => {
  const events = classifyLogs([
    log([TOPICS.UPGRADED, word(B)], { tx: '0x04', address: A }),
    log([TOPICS.OWNERSHIP, word(ZERO), word(C)], { tx: '0x04', address: C }),
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].address, A);
});

test('ownership minted from zero is deploy noise and hides the factory handoff in the same tx', () => {
  const events = classifyLogs([
    log([TOPICS.OWNERSHIP, word(ZERO), word(B)], { tx: '0x05' }),
    log([TOPICS.OWNERSHIP, word(B), word(C)], { tx: '0x05' }),
  ]);
  assert.deepEqual(events, []);
});

test('ownership to zero is a renounce, between two addresses is a handoff', () => {
  const events = classifyLogs([
    log([TOPICS.OWNERSHIP, word(B), word(ZERO)], { tx: '0x06', block: 200 }),
    log([TOPICS.OWNERSHIP, word(B), word(C)], { tx: '0x07', block: 300 }),
  ]);
  assert.deepEqual(events.map((e) => e.kind), ['owner', 'renounce']);
  assert.equal(events[0].from, B);
  assert.equal(events[0].target, C);
  assert.equal(events[1].from, B);
});

test('AdminChanged reads both admins from data and ignores the constructor case', () => {
  const events = classifyLogs([
    log([TOPICS.ADMIN_CHANGED], { tx: '0x08', data: word(ZERO) + word(B).slice(2) }),
    log([TOPICS.ADMIN_CHANGED], { tx: '0x09', data: word(B) + word(C).slice(2) }),
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'admin');
  assert.equal(events[0].from, B);
  assert.equal(events[0].target, C);
});

test('Paused works with the account in data or indexed', () => {
  const events = classifyLogs([
    log([TOPICS.PAUSED], { tx: '0x0a', data: word(B), block: 10 }),
    log([TOPICS.UNPAUSED, word(B)], { tx: '0x0b', block: 20 }),
  ]);
  assert.deepEqual(events.map((e) => [e.kind, e.from]), [['unpause', B], ['pause', B]]);
});

test('BeaconUpgraded only fires when a beacon proxy is built, so it marks a deploy', () => {
  assert.deepEqual(classifyLogs([log([TOPICS.BEACON_UPGRADED, word(C)], { tx: '0x0c' })]), []);
  const [e] = classifyLogs([log([TOPICS.BEACON_UPGRADED, word(C)], { tx: '0x0c' })], { keepDeploys: true });
  assert.equal(e.kind, 'beacon');
  assert.equal(e.target, C);
  assert.equal(e.atDeploy, true);
});

test('ownership sent to the dead address counts as a renounce', () => {
  const DEAD = '0x000000000000000000000000000000000000dead';
  const [e] = classifyLogs([log([TOPICS.OWNERSHIP, word(B), word(DEAD)], { tx: '0x12' })]);
  assert.equal(e.kind, 'renounce');
});

test('keepDeploys returns deploy-time events flagged instead of dropping them', () => {
  const events = classifyLogs(
    [
      log([TOPICS.OWNERSHIP, word(ZERO), word(B)], { tx: '0x0d' }),
      log([TOPICS.UPGRADED, word(C)], { tx: '0x0d' }),
    ],
    { keepDeploys: true },
  );
  assert.deepEqual(events.map((e) => [e.kind, e.atDeploy]).sort(), [['code', true], ['created', true]]);
});

test('events come back newest first, and unknown or malformed logs are skipped', () => {
  const events = classifyLogs([
    log([TOPICS.UPGRADED, word(B)], { tx: '0x0e', block: 5 }),
    log(['0x' + 'f'.repeat(64)], { tx: '0x0f', block: 9 }),
    log([TOPICS.UPGRADED], { tx: '0x10', block: 7 }),
    log([TOPICS.UPGRADED, word(C)], { tx: '0x11', block: 8 }),
  ]);
  assert.deepEqual(events.map((e) => e.block), [8, 5]);
});

test('isDelegatedWallet spots EIP-7702 delegation code', () => {
  assert.equal(isDelegatedWallet('0xef0100' + 'ab'.repeat(20)), true);
  assert.equal(isDelegatedWallet('0x6080604052'), false);
  assert.equal(isDelegatedWallet('0x'), false);
  assert.equal(isDelegatedWallet(undefined), false);
});

test('decodeString reads ABI strings and bytes32 names, rejects junk', () => {
  const abi = '0x' + num(32).slice(2) + num(5).slice(2) + Buffer.from('SENSE').toString('hex').padEnd(64, '0');
  assert.equal(decodeString(abi), 'SENSE');
  const b32 = '0x' + Buffer.from('MKR').toString('hex').padEnd(64, '0');
  assert.equal(decodeString(b32), 'MKR');
  assert.equal(decodeString('0x'), null);
  assert.equal(decodeString(undefined), null);
  const evil = '0x' + num(32).slice(2) + num(9).slice(2) + Buffer.from('<b>x</b>!').toString('hex').padEnd(64, '0');
  assert.equal(decodeString(evil), '<b>x</b>!');
  const utf8 = Buffer.from('ロビン‮EVIL');
  const uni = '0x' + num(32).slice(2) + num(utf8.length).slice(2) + utf8.toString('hex').padEnd(64, '0');
  assert.equal(decodeString(uni), 'ロビンEVIL');
});

test('windowsFor splits a range into capped, newest-first windows', () => {
  assert.deepEqual(windowsFor(100, 1, 40), [[61, 100], [21, 60], [1, 20]]);
  assert.deepEqual(windowsFor(10, 10, 40), [[10, 10]]);
  assert.deepEqual(windowsFor(5, 10, 40), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupEvents } from '../view.js';

const ev = (address, block, extra = {}) => ({ kind: 'owner', from: '0xf', target: '0xt', address, block, ...extra });

test('a burst of the same handoff across contracts becomes one group', () => {
  const groups = groupEvents([ev('0x1', 100), ev('0x2', 99), ev('0x3', 98)]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].items.map((e) => e.address), ['0x1', '0x2', '0x3']);
});

test('different keys, kinds, or a long gap break the group', () => {
  const groups = groupEvents([
    ev('0x1', 100_000),
    ev('0x2', 99_000, { target: '0xother' }),
    ev('0x3', 98_000, { target: '0xother', kind: 'admin' }),
    ev('0x4', 97_000, { target: '0xother', kind: 'admin' }),
    ev('0x5', 1_000, { target: '0xother', kind: 'admin' }),
  ]);
  assert.deepEqual(groups.map((g) => g.items.length), [1, 1, 2, 1]);
});

test('the same contract twice is never folded into one group', () => {
  const groups = groupEvents([ev('0x1', 10, { kind: 'pause' }), ev('0x1', 9, { kind: 'pause' })]);
  assert.equal(groups.length, 2);
});

test('events without any keys are never grouped', () => {
  const groups = groupEvents([ev('0x1', 10, { from: null, target: undefined }), ev('0x2', 9, { from: null, target: undefined })]);
  assert.equal(groups.length, 2);
});

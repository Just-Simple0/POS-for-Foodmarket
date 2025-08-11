import test from 'node:test';
import assert from 'node:assert/strict';
import { getQuarterKey, filterProvisionsByQuarter, updateCustomerLifeLove } from '../js/utils/lifelove.js';

test('life-love provision stores quarterKey and updates customer record', () => {
  const date = new Date('2024-04-15');
  const quarterKey = getQuarterKey(date);
  const provision = { quarterKey, lifelove: true };
  assert.equal(quarterKey, '2024-Q1');
  assert.equal(provision.lifelove, true);
  const customer = updateCustomerLifeLove({}, quarterKey, provision.lifelove);
  assert.deepEqual(customer, { '2024-Q1': true });
});

test('filterProvisionsByQuarter returns matching life-love records', () => {
  const provisions = [
    { quarterKey: '2024-Q1', lifelove: true },
    { quarterKey: '2024-Q2', lifelove: true }
  ];
  const filtered = filterProvisionsByQuarter(provisions, '2024-Q1');
  assert.deepEqual(filtered, [{ quarterKey: '2024-Q1', lifelove: true }]);
});

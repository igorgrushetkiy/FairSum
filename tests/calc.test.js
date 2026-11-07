import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, computeBill, settle, toCents } from '../js/calc.js';

test('toCents понимает запятую и пробелы', () => {
  assert.equal(toCents('85,50'), 8550);
  assert.equal(toCents('1 234.05'), 123405);
  assert.equal(toCents('1.005'), 101);
  assert.equal(toCents(''), 0);
  assert.equal(toCents('abc'), 0);
});

test('allocate: сумма частей всегда равна целому', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(1000, [2, 1, 0]), [667, 333, 0]);
  assert.deepEqual(allocate(-10, [1, 1, 1]), [-4, -3, -3]);
  assert.deepEqual(allocate(500, [0, 0]), [0, 0]);
  for (let t = 1; t < 500; t += 37) {
    const parts = allocate(t, [0.5, 1.5, 3, 1]);
    assert.equal(parts.reduce((a, b) => a + b, 0), t);
  }
});

function sampleBill() {
  // Ивановы: Игорь, Аня. Петровы: Петя. Сидоров (один).
  return {
    families: [
      { id: 'iv', name: 'Ивановы' },
      { id: 'pe', name: 'Петровы' },
      { id: 'si', name: 'Сидоров' },
    ],
    people: [
      { id: 'igor', name: 'Игорь', familyId: 'iv' },
      { id: 'anya', name: 'Аня', familyId: 'iv' },
      { id: 'petya', name: 'Петя', familyId: 'pe' },
      { id: 'sid', name: 'Сидоров', familyId: 'si' },
    ],
    items: [
      { id: '1', name: 'Пицца', amount: '300', shares: { igor: 1, anya: 1, petya: 1 } }, // по 100
      { id: '2', name: 'Вино', amount: '400', shares: { igor: 2, petya: 1, sid: 1 } }, // 200/100/100
      { id: '3', name: 'Салат', amount: '100.00', shares: { anya: 1 } },
      { id: '4', name: 'Стейк', amount: '200', shares: { sid: 1 } },
    ],
    service: { mode: 'percent', value: '' },
    discount: { mode: 'percent', value: '' },
    tip: { mode: 'percent', value: '10' },
    payments: {},
    fullPayer: 'iv',
  };
}

test('еда по семьям и чаевые пропорционально', () => {
  const r = computeBill(sampleBill());
  assert.equal(r.itemsTotal, 100000);
  assert.equal(r.tip, 10000);
  assert.equal(r.grandTotal, 110000);
  const by = Object.fromEntries(r.rows.map((x) => [x.id, x]));
  assert.equal(by.iv.food, 50000); // 100+100+200+100
  assert.equal(by.pe.food, 20000);
  assert.equal(by.si.food, 30000);
  assert.equal(by.iv.tip, 5000);
  assert.equal(by.pe.tip, 2000);
  assert.equal(by.si.tip, 3000);
  assert.equal(r.owedTotal, r.grandTotal);
  assert.equal(by.iv.members.find((m) => m.id === 'igor').food, 30000);
});

test('один плательщик: остальные переводят ему', () => {
  const r = computeBill(sampleBill());
  assert.equal(r.paidTotal, 110000);
  assert.deepEqual(r.transfers, [
    { from: 'si', to: 'iv', amount: 33000 },
    { from: 'pe', to: 'iv', amount: 22000 },
  ]);
});

test('обслуживание, скидка и чаевые суммой', () => {
  const b = sampleBill();
  b.service = { mode: 'percent', value: '10' }; // 100
  b.discount = { mode: 'amount', value: '50' };
  b.tip = { mode: 'amount', value: '33,33' };
  const r = computeBill(b);
  assert.equal(r.service, 10000);
  assert.equal(r.discount, 5000);
  assert.equal(r.tip, 3333);
  assert.equal(r.grandTotal, 100000 + 10000 - 5000 + 3333);
  assert.equal(r.owedTotal, r.grandTotal);
});

test('процент чаевых — от суммы с обслуживанием и скидкой', () => {
  const b = sampleBill();
  b.service = { mode: 'percent', value: '10' };
  const r = computeBill(b);
  assert.equal(r.tip, 11000);
});

test('нераспределённые позиции учитываются отдельно', () => {
  const b = sampleBill();
  b.items.push({ id: '5', name: 'Кофе', amount: '50', shares: {} });
  const r = computeBill(b);
  assert.equal(r.unassigned, 5000);
});

test('несколько плательщиков', () => {
  const b = sampleBill();
  b.fullPayer = null;
  b.payments = { iv: '600', pe: '500' };
  const r = computeBill(b);
  // должны: iv 550, pe 220, si 330 ; заплатили: 600, 500, 0
  assert.deepEqual(r.transfers, [
    { from: 'si', to: 'pe', amount: 28000 },
    { from: 'si', to: 'iv', amount: 5000 },
  ]);
});

test('settle: без долгов — без переводов', () => {
  assert.deepEqual(settle([{ id: 'a', balance: 0 }, { id: 'b', balance: 0 }]), []);
});

test('неравное деление: штуки и дроби', async () => {
  const { parseWeight, splitItem } = await import('../js/calc.js');
  assert.equal(parseWeight('1/4'), 0.25);
  assert.equal(parseWeight('0,5'), 0.5);
  assert.equal(parseWeight(''), 0);
  assert.ok(Number.isNaN(parseWeight('abc')));
  const people = [{ id: 'yura' }, { id: 'me' }];
  // Хинкали 90: Юра 2 штуки, я 1.
  assert.deepEqual(splitItem({ amount: '90', shares: { yura: 2, me: 1 } }, people), { yura: 6000, me: 3000 });
  // Хачапури 120: я четвертинку, Юра остальное.
  assert.deepEqual(splitItem({ amount: '120', shares: { yura: 0.75, me: 0.25 } }, people), { yura: 9000, me: 3000 });
});

test('бутылка на троих из двух семей и чаевые суммой', async () => {
  const { computeBill } = await import('../js/calc.js');
  const r = computeBill({
    families: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }],
    people: [{ id: 'a1', familyId: 'A' }, { id: 'a2', familyId: 'A' }, { id: 'b1', familyId: 'B' }],
    items: [{ amount: '300', shares: { a1: 1, a2: 1, b1: 1 } }],
    tip: { mode: 'amount', value: '30' },
    payments: {},
  });
  assert.deepEqual(r.rows.map((x) => x.food), [20000, 10000]);
  assert.deepEqual(r.rows.map((x) => x.tip), [2000, 1000]);
});

test('итог семьи с чаевыми округляется до целых, сумма чаевых не меняется', () => {
  const r = computeBill({
    families: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }, { id: 'C', name: 'C' }],
    people: [{ id: 'a', familyId: 'A' }, { id: 'b', familyId: 'B' }, { id: 'c', familyId: 'C' }],
    items: [
      { amount: '300', shares: { a: 1 } },
      { amount: '415.50', shares: { b: 1 } },
      { amount: '314.50', shares: { c: 1 } },
    ],
    tip: { mode: 'amount', value: '100' },
    payments: {},
  });
  assert.equal(r.tip, 10000);
  assert.equal(r.rows.reduce((a, x) => a + x.tip, 0), 10000);
  assert.ok(r.rows.every((x) => x.owed % 100 === 0), JSON.stringify(r.rows.map((x) => x.owed)));
  assert.equal(r.rows.reduce((a, x) => a + x.owed, 0), 113000);
});

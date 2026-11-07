import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bestParse, parseReceipt } from '../js/parse.js';

test('простой русский чек', () => {
  const { items, total } = parseReceipt(`
РЕСТОРАН «У ДОРОГИ»
Стол 5   Официант: Мария
06.11.2026 21:45
Пицца Маргарита     1   125.00
Картофель фри       1    45,00
Пиво светлое 0,5   3 x 40.00  120.00
Салат Цезарь с
курицей                 98.00
ИТОГО:                 388.00
Оплата картой          388.00
Спасибо!
`);
  assert.deepEqual(
    items.map((i) => [i.name, i.amount]),
    [
      ['Пицца Маргарита', 125],
      ['Картофель фри', 45],
      ['Пиво светлое 0,5 (×3)', 120],
      ['Салат Цезарь с курицей', 98],
    ],
  );
  assert.equal(total, 388);
});

test('румынский фискальный чек: количество на отдельной строке', () => {
  const { items, total } = parseReceipt(`
S.R.L. LA PLACINTE
IDNO 1003600012345
Placinta cu branza
2.000 x 35.00
70.00 A
Mamaliga
1.000 x 40,00 = 40,00 A
Vin rosu 150ml 55.00 A
TOTAL 165.00
NUMERAR 200.00
REST 35.00
`);
  assert.deepEqual(
    items.map((i) => [i.name, i.amount]),
    [
      ['Placinta cu branza (×2)', 70],
      ['Mamaliga', 40],
      ['Vin rosu 150ml', 55],
    ],
  );
  assert.equal(total, 165);
});

test('английский чек и итог с пробелом-разделителем тысяч', () => {
  const { items, total } = parseReceipt(`
Burger 120.00
Lemonade 2 @ 30.00 60.00
Subtotal 180.00
Service 10% 18.00
Total 1 198.00
`);
  assert.deepEqual(items.map((i) => [i.name, i.amount]), [['Burger', 120], ['Lemonade (×2)', 60]]);
  assert.equal(total, 1198);
});

test('чек без копеек', () => {
  const { items, total } = parseReceipt(`
Шашлык 180
Компот 25
Итого 205
`);
  assert.deepEqual(items.map((i) => [i.name, i.amount]), [['Шашлык', 180], ['Компот', 25]]);
  assert.equal(total, 205);
});

test('пустой текст', () => {
  assert.deepEqual(parseReceipt(''), { items: [], total: null, matched: false });
});

// Реальный чек ресторана: таблица с рамками, многострочные названия, суммы без копеек.
// Фикстуры — настоящие выводы Tesseract для разных вариантов обработки фото.
test('реальный чек «Тбилисо»: объединение вариантов распознавания и сверка с итогом', () => {
  const read = (k) => readFileSync(new URL(`./fixtures/tbiliso-${k}.txt`, import.meta.url), 'utf8');
  const r = bestParse([read('gray-psm6'), read('binary-psm4')]);
  assert.equal(r.total, 1030);
  assert.equal(r.matched, true);
  assert.deepEqual(r.items.map((i) => i.amount), [120, 130, 140, 280, 90, 90, 30, 100, 50]);
  assert.match(r.items[0].name, /Хачапури Классический 1\/500/);
  assert.match(r.items[1].name, /^KHACHAPURI CU CIUPERCI SI CASCAVAL 1\/500$/);
  assert.equal(r.items[3].name, 'Harcho 1/350 (×2)');
});

test('bestParse: одного варианта без итога достаточно, чтобы вернуть позиции', () => {
  const r = bestParse(['Пицца 1 120.00\nЧай 1 30.00']);
  assert.deepEqual(r.items.map((i) => i.amount), [120, 30]);
  assert.equal(r.matched, false);
});

test('сверка с итогом исправляет потерянную запятую', () => {
  const r = parseReceipt('Суп 1 5000 50\nСалат 1 10000\nИтого 150,00');
  assert.equal(r.matched, true);
  assert.deepEqual(r.items.map((i) => i.amount), [50, 100]);
});

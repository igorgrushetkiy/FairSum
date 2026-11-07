// Расчёт счёта. Все суммы внутри — в целых копейках/банах, чтобы не было ошибок округления.

export function parseNum(v) {
  if (typeof v === 'number') return v;
  if (v == null) return NaN;
  const t = String(v).replace(/[\s ]/g, '').replace(',', '.');
  if (t === '') return NaN;
  return Number(t);
}

export function toCents(v) {
  const n = parseNum(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Number((n * 100).toFixed(6)));
}

// Делит total (в копейках) пропорционально весам методом наибольших остатков.
// Сумма результата всегда в точности равна total.
export function allocate(total, weights) {
  const out = weights.map(() => 0);
  const W = weights.reduce((a, w) => a + (w > 0 ? w : 0), 0);
  if (!W || !total) return out;
  const sign = total < 0 ? -1 : 1;
  const T = Math.abs(total);
  let used = 0;
  const rem = [];
  weights.forEach((w, i) => {
    if (!(w > 0)) return;
    const exact = (T * w) / W;
    const f = Math.floor(exact + 1e-9);
    out[i] = f;
    used += f;
    rem.push([exact - f, i]);
  });
  rem.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; used < T; k++, used++) out[rem[k % rem.length][1]] += 1;
  return out.map((x) => x * sign);
}

// { mode: 'percent' | 'amount', value } -> копейки
export function extraCents(spec, base) {
  if (!spec) return 0;
  const v = parseNum(spec.value);
  if (!Number.isFinite(v)) return 0;
  return spec.mode === 'amount' ? toCents(v) : Math.round((base * v) / 100);
}

// Минимальный набор переводов: должники платят тем, кто переплатил.
export function settle(balances) {
  const cred = balances.filter((b) => b.balance > 0).map((b) => ({ id: b.id, amt: b.balance }));
  const debt = balances.filter((b) => b.balance < 0).map((b) => ({ id: b.id, amt: -b.balance }));
  cred.sort((a, b) => b.amt - a.amt);
  debt.sort((a, b) => b.amt - a.amt);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < debt.length && j < cred.length) {
    const x = Math.min(debt[i].amt, cred[j].amt);
    if (x > 0) out.push({ from: debt[i].id, to: cred[j].id, amount: x });
    debt[i].amt -= x;
    cred[j].amt -= x;
    if (!debt[i].amt) i++;
    if (!cred[j].amt) j++;
  }
  return out;
}

// Доля участника: число («2», «0,5») или дробь («1/4»). Пусто — 0, ошибка — NaN.
export function parseWeight(v) {
  const t = String(v ?? '').replace(/\s/g, '').replace(',', '.');
  if (t === '') return 0;
  const m = t.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  const n = m ? Number(m[1]) / Number(m[2]) : Number(t);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

// Как делится позиция: { [personId]: копейки } для отмеченных участников.
export function splitItem(item, people) {
  const ids = people.map((p) => p.id).filter((id) => (item.shares?.[id] || 0) > 0);
  const parts = allocate(toCents(item.amount), ids.map((id) => item.shares[id]));
  return Object.fromEntries(ids.map((id, k) => [id, parts[k]]));
}

// Чаевые даются наличными, поэтому итог каждой семьи с чаевыми округляется до целых:
// разница уходит в чаевые семьи, а их общая сумма не меняется.
// Если общий итог сам не целый, остаток копеек достаётся семье с наибольшей суммой.
function roundWithTips(bills, tips) {
  const tip = tips.reduce((a, x) => a + x, 0);
  if (!tip) return;
  const owed = bills.map((b, i) => b + tips[i]);
  const total = owed.reduce((a, x) => a + x, 0);
  if (total <= 0 || owed.some((x) => x < 0)) return;
  const lei = allocate(Math.floor(total / 100), owed).map((x) => x * 100);
  const big = owed.indexOf(Math.max(...owed));
  lei[big] += total % 100;
  lei.forEach((x, i) => (tips[i] += x - owed[i]));
}

export function computeBill(bill) {
  const people = bill.people || [];
  const families = bill.families || [];
  const personFood = Object.fromEntries(people.map((p) => [p.id, 0]));

  let itemsTotal = 0;
  let unassigned = 0;
  for (const it of bill.items || []) {
    const c = toCents(it.amount);
    itemsTotal += c;
    const split = splitItem(it, people);
    if (!Object.keys(split).length) {
      unassigned += c;
      continue;
    }
    for (const [id, v] of Object.entries(split)) personFood[id] += v;
  }

  const service = extraCents(bill.service, itemsTotal);
  const discount = extraCents(bill.discount, itemsTotal);
  // Чаевые вводятся суммой; процент остался только для старых счетов.
  const tip = extraCents(bill.tip, itemsTotal + service - discount);
  const grandTotal = itemsTotal + service - discount + tip;

  const food = families.map((f) =>
    people.filter((p) => p.familyId === f.id).reduce((a, p) => a + personFood[p.id], 0),
  );
  // Обслуживание, скидка и чаевые — пропорционально сумме каждой семьи.
  const svc = allocate(service, food);
  const disc = allocate(discount, food);
  const tips = allocate(tip, food);
  roundWithTips(food.map((x, i) => x + svc[i] - disc[i]), tips);

  const fullPayer = families.some((f) => f.id === bill.fullPayer) ? bill.fullPayer : null;

  const rows = families.map((f, i) => {
    const owed = food[i] + svc[i] - disc[i] + tips[i];
    const paid = fullPayer ? (f.id === fullPayer ? grandTotal : 0) : toCents(bill.payments?.[f.id]);
    return {
      id: f.id,
      name: f.name,
      food: food[i],
      service: svc[i],
      discount: disc[i],
      tip: tips[i],
      owed,
      paid,
      balance: paid - owed,
      members: people
        .filter((p) => p.familyId === f.id)
        .map((p) => ({ id: p.id, name: p.name, food: personFood[p.id] })),
    };
  });

  const paidTotal = rows.reduce((a, r) => a + r.paid, 0);
  const owedTotal = rows.reduce((a, r) => a + r.owed, 0);

  return {
    itemsTotal,
    service,
    discount,
    tip,
    grandTotal,
    unassigned,
    rows,
    paidTotal,
    owedTotal,
    transfers: paidTotal ? settle(rows) : [],
  };
}

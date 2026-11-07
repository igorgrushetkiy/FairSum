// Разбор распознанного текста чека в список позиций.
// OCR ошибается (теряет запятые, добавляет мусор от линий таблицы), поэтому разбор эвристический
// и устойчивый к шуму: сумма позиции — последнее число строки, проверяется через «кол-во × цена».
// Результат всегда можно поправить руками.

const word = (list) => new RegExp(`(?:^|[^\\p{L}])(?:${list.join('|')})(?![\\p{L}])`, 'iu');

const TOTAL_RE = word([
  'итого', 'итог', 'всего', 'всего\\s*к\\s*оплате', 'к\\s*оплате',
  'total', 'in\\s*total', 'grand\\s*total', 'amount\\s*due',
  'total\\s*de\\s*plat\\p{L}*', 'suma\\s*(?:de\\s*)?plat\\p{L}*', 'spre\\s*plat\\p{L}*',
]);

const SKIP_RE = word([
  // русский
  'подытог', 'сумм[аы]?', 'скидк\\p{L}*', 'сдача', 'наличн\\p{L}*', 'безнал\\p{L}*',
  'карт(?:а|ой|е|у)', 'ндс', 'налог\\p{L}*', 'чаев\\p{L}*', 'обслуживани\\p{L}*',
  'сч[её]т', 'чек', 'стол', 'столик', 'официант\\p{L}*', 'кассир\\p{L}*', 'смена', 'дата', 'время',
  'тел', 'адрес', 'спасибо', 'гост(?:ей|и|ь)', 'оплат\\p{L}*', 'наименование', 'кол-во', 'цена',
  // румынский / английский
  'subtotal', 'sub\\s*total', 'suma', 'plat[aă]', 'rest', 'numerar', 'card', 'cash', 'change',
  'tax', 'vat', 'tva', 'discount', 'reducere', 'tips?', 'bac[sș]i[sș]', 'service',
  'serviciu\\p{L}*', 'fiscal\\p{L}*', 'bon', 'nota', 'mas[aă]', 'osp[aă]tar', 'chelner',
  'table', 'waiter', 'date', 'data', 'ora', 'time', 'idno', 'cod', 'thank\\p{L}*',
  'mul[tț]umim', 'visa', 'mastercard', 'maestro', 'terminal', 'guests?', 'persoane',
  'phone', 'cashier', 'casier', 'printed', 'denumirea', 'pre[tț]ul', 'cant',
]);

// Денежная сумма с копейками: 85.00, 85,00
const MONEY_RE = /(^|[^\d.,])(-?\d+)[.,](\d{2})(?!\d)(?![.,]\d)/g;
// Количество × цена: «2 x 45.00», «2.000 х 45,00», «2*45.00», «2 @ 45.00»
const QTY_RE = /(\d+(?:[.,]\d+)?)\s*[xхX×*@]\s*(\d+[.,]\d{2})(?!\d)/;
// Вес/объём порции в названии: 1/500, 0.5л
const WEIGHT_RE = /\d+\s*\/\s*\d+/;

function normalize(line) {
  return line
    .replace(/[|¦\]\[(){}<>«»"“”„‚`~^®©°!?]/g, ' ')
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, ' ') // даты
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ') // время
    .replace(/(\d)\s+([.,])(\d{2})(?!\d)/g, '$1$2$3') // «45 .00»
    .replace(/(\d)([.,])\s+(\d{2})(?!\d)/g, '$1$2$3') // «45. 00»
    .replace(/\s+/g, ' ')
    .replace(/(\d)\s+[A-ZА-Я]$/, '$1') // буква налоговой группы после суммы: «55.00 A»
    .trim();
}

const round2 = (x) => Math.round(x * 100) / 100;
const near = (a, b) => Math.abs(a - b) < 0.011 * Math.max(1, Math.abs(b));

// Число-токен: «120», «120,00», «90,», «1.», «_1...», «0о» → { v, dec2, raw }
function numToken(tok) {
  let t = tok.replace(/^[_\-–—'.,:;*=#]+|[_'.,:;*=#]+$/g, (m, off) => (off === 0 ? '' : m.replace(/[^.,]/g, '').slice(0, 1)));
  t = t.replace(/[оОoO]/g, '0');
  if (!/^-?\d{1,6}(?:[.,]\d{0,2})?$/.test(t)) return null;
  const clean = t.replace(/[.,]$/, '');
  const v = Number(clean.replace(',', '.'));
  if (!Number.isFinite(v)) return null;
  return { v, dec2: /[.,]\d{2}$/.test(clean) };
}

const isQty = (t) => t && Number.isInteger(t.v) && t.v > 0 && t.v <= 50;
// Число, потерявшее запятую: 14000 вместо 140,00
const unComma = (t) => (Number.isInteger(t.v) && t.v >= 100 && t.v % 100 === 0 && !t.dec2 ? t.v / 100 : null);

// По хвосту из чисел определяет сумму позиции и количество.
// alts — другие правдоподобные прочтения суммы (на случай ошибок OCR); их проверяем по итогу чека.
function interpret(nums) {
  const n = nums.length;
  if (!n) return null;
  const s = nums[n - 1];
  const alts = [unComma(s)];
  if (n === 1) return s.dec2 && s.v > 0 ? { amount: s.v, qty: 1, alts: [] } : null;

  if (n === 2) {
    const a = nums[0];
    const aPrice = unComma(a) ?? a.v;
    if (!(s.v > 0 && (s.v >= a.v || s.v >= aPrice))) return null;
    alts.push(aPrice, a.v);
    return { amount: s.v, qty: isQty(a) ? a.v : 1, alts };
  }

  const q = nums[n - 3];
  const p = nums[n - 2];
  const qv = isQty(q) ? q.v : 1;
  const prices = [p.v, unComma(p)].filter((x) => x != null);
  const sums = [s.v, unComma(s)].filter((x) => x != null);
  let amount = s.v;
  // Подбираем трактовку, при которой кол-во × цена = сумма.
  outer: for (const sv of sums) for (const pv of prices) if (near(qv * pv, sv)) { amount = sv; break outer; }
  for (const pv of prices) alts.push(qv * pv);
  alts.push(s.v);
  return amount > 0 ? { amount: round2(amount), qty: qv, alts } : null;
}

// Разбивает строку на «название» и хвост из чисел.
function splitLine(line) {
  const tokens = line.split(' ').filter((t) => t && !/^[.,:;'_\-–—=*#]+$/.test(t));
  const nums = [];
  let i = tokens.length;
  while (i > 0) {
    const tok = tokens[i - 1];
    if (WEIGHT_RE.test(tok) || /^[оОoO]{2}$/.test(tok)) {
      if (/^[оОoO]{2}$/.test(tok) && i > 1 && numToken(tokens[i - 2])) {
        // «30 оо» — потерянные копейки «30,00»
        nums.unshift({ ...numToken(tokens[i - 2]), dec2: true });
        i -= 2;
        continue;
      }
      break;
    }
    const nt = numToken(tok);
    if (!nt) break;
    nums.unshift(nt);
    i--;
  }
  return { name: tokens.slice(0, i).join(' '), nums };
}

function cleanName(s) {
  let t = s
    .replace(QTY_RE, ' ')
    .replace(/\s+[A-ZА-Я]\s*$/, '') // буква налоговой группы
    .replace(/^\s*[#№]?\d+[.)]?\s+(?=\p{L})/u, '') // номер позиции в начале
    .replace(/[=*_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Хвостовой мусор от OCR: одиночные цифры и знаки (вес порции «1/400» не трогаем).
  const parts = t.split(' ');
  while (parts.length > 1 && /^(?:\d{1,2}|[^\p{L}\d])$/u.test(parts[parts.length - 1])) parts.pop();
  t = parts.join(' ');
  // Вес порции обычно завершает название — всё после него, как правило, мусор от OCR.
  const w = [...t.matchAll(/\d+\s*\/\s*\d+/g)].pop();
  if (w && /^\s*\S{1,3}(\s+\S{1,3})*\s*$/u.test(t.slice(w.index + w[0].length))) t = t.slice(0, w.index + w[0].length);
  return t.replace(/^[\s\-–—:.,#]+|[\s\-–—:.,#xх×]+$/g, '').trim();
}

const hasLetters = (s) => /\p{L}{2,}/u.test(s);
// Продолжение названия предыдущей позиции: со строчной буквы, с цифры или с веса порции.
const looksContinuation = (s) => WEIGHT_RE.test(s) || /^[\p{Ll}\d]/u.test(s);

function totalOf(line) {
  const t = line.replace(/(\d)[  ](\d{3})(?!\d)/g, '$1$2');
  const m = [...t.matchAll(/\d+(?:[.,]\d{0,2})?/g)];
  if (!m.length) return null;
  const v = Number(m[m.length - 1][0].replace(/[.,]$/, '').replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

export function parseReceipt(text, opts = {}) {
  const lines = String(text || '').split(/\r?\n/).map(normalize).filter(Boolean);
  const anyMoney = lines.some((l) => MONEY_RE.test(l) && !(MONEY_RE.lastIndex = 0));
  MONEY_RE.lastIndex = 0;

  const items = [];
  let total = null;
  let pending = []; // строки с текстом без цены — возможно, начало названия следующей позиции
  let last = null; // последняя позиция, к которой может относиться продолжение названия

  const reset = () => {
    pending = [];
    last = null;
  };

  for (let line of lines) {
    // Чек без копеек: «Пицца 85» — допускаем целую цену в конце строки.
    if (!anyMoney) {
      const m = line.match(/^(.*\p{L}.*?)\s+(\d{1,6})$/u);
      if (m) line = `${m[1]} ${m[2]}.00`;
    }

    if (TOTAL_RE.test(line)) {
      const v = totalOf(line);
      if (v != null) total = Math.max(total ?? 0, v);
      reset();
      continue;
    }
    if (SKIP_RE.test(line)) {
      reset();
      continue;
    }

    // «2 x 45.00» без итоговой суммы — считаем сами.
    let parsed = null;
    const q = line.match(QTY_RE);
    if (q) {
      const qty = Number(q[1].replace(',', '.'));
      const unit = Number(q[2].replace(',', '.'));
      const rest = line.slice(q.index + q[0].length);
      const after = splitLine(rest.trim()).nums;
      const amount = after.length ? after[after.length - 1].v : round2(qty * unit);
      parsed = { name: line.slice(0, q.index), amount, qty, alts: [round2(qty * unit)] };
    } else {
      const { name, nums } = splitLine(line);
      const it = interpret(nums);
      if (it) parsed = { name, ...it };
    }

    if (!parsed) {
      // Строка без цены.
      if (!hasLetters(line)) continue;
      const cleaned = cleanName(line);
      if (last && !WEIGHT_RE.test(last.name) && looksContinuation(cleaned)) {
        last.name = `${last.name} ${cleaned}`.trim();
      } else {
        pending.push(cleaned);
        if (pending.length > 2) pending.shift();
      }
      continue;
    }

    let name = cleanName(parsed.name);
    if (!hasLetters(name)) {
      if (!pending.length && last && near(parsed.amount, last.amount)) {
        // Строка «70.00 A» после «2 x 35.00» — сумма уже учтена.
        last = null;
        continue;
      }
      name = pending.join(' ');
    } else if (pending.length) {
      name = `${pending.join(' ')} ${name}`;
    }
    pending = [];

    const amount = round2(parsed.amount);
    const alts = [...new Set((parsed.alts || []).filter((x) => x > 0).map(round2))].filter((x) => x !== amount);
    const item = { name, amount, qty: parsed.qty, alts };
    items.push(item);
    last = item;
  }

  if (opts.total) total = opts.total;
  const matched = total ? fitTotal(items, total) : false;

  for (const it of items) {
    it.name = it.name.replace(/\s+/g, ' ').trim();
    if (it.qty > 1 && Number.isInteger(it.qty) && it.name) it.name = `${it.name} (×${it.qty})`;
    delete it.alts;
  }
  return { items, total, matched };
}

const sumOf = (items) => round2(items.reduce((a, i) => a + i.amount, 0));
const same = (a, b) => Math.abs(a - b) < 0.005;

// Подгоняет суммы позиций под итог чека, выбирая альтернативные прочтения (максимум два исправления).
function fitTotal(items, T) {
  for (const it of items) {
    if (it.amount > T) {
      const fix = it.alts.find((a) => a <= T);
      if (fix != null) it.amount = fix;
    }
  }
  let sum = sumOf(items);
  if (same(sum, T)) return true;
  for (const it of items) {
    for (const a of it.alts) {
      if (same(sum - it.amount + a, T)) { it.amount = a; return true; }
    }
  }
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    for (const a of items[i].alts) for (const b of items[j].alts) {
      if (same(sum - items[i].amount - items[j].amount + a + b, T)) {
        items[i].amount = a;
        items[j].amount = b;
        return true;
      }
    }
  }
  return false;
}

// Выбирает лучший результат из нескольких вариантов распознавания одного чека.
// Итог берём из любого варианта, где он прочитался, и проверяем им позиции всех вариантов.
export function bestParse(texts) {
  const own = texts.map((t) => parseReceipt(t));
  const freq = new Map();
  for (const r of own) if (r.total > 0) freq.set(r.total, (freq.get(r.total) || 0) + 1);
  // Итог не может быть сильно меньше суммы найденных позиций (отсекаем «итоги» вроде «3»).
  const maxSum = Math.max(0, ...own.map((r) => Math.min(...r.items.map((i) => i.amount), Infinity) * r.items.length));
  const totals = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0] - a[0])
    .map(([v]) => v)
    .filter((v) => v > 0 && v >= maxSum * 0.5);

  for (const T of totals) {
    const fits = texts.map((t) => parseReceipt(t, { total: T })).filter((r) => r.matched);
    if (fits.length) {
      // Из совпавших — тот, где больше позиций и длиннее названия (обычно чище распознан).
      fits.sort((a, b) => b.items.length - a.items.length || nameLen(b) - nameLen(a));
      return fits[0];
    }
  }
  // Ничего не сошлось: берём вариант с наибольшим числом позиций и самым правдоподобным итогом.
  const T = totals[0] ?? null;
  const all = texts.map((t) => parseReceipt(t, T ? { total: T } : {}));
  all.sort((a, b) => b.items.length - a.items.length || Math.abs(sumOf(a.items) - (T || 0)) - Math.abs(sumOf(b.items) - (T || 0)));
  return all[0] || { items: [], total: null, matched: false };
}

const nameLen = (r) => r.items.reduce((a, i) => a + (/\p{L}/u.test(i.name) ? i.name.length : 0), 0);


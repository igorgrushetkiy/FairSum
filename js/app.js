import * as S from './store.js';
import { computeBill, parseNum, parseWeight, splitItem, toCents } from './calc.js';
import { bestParse } from './parse.js';
import { recognize } from './ocr.js';

const app = document.getElementById('app');

// Временное состояние интерфейса (не сохраняется).
const ui = {
  expanded: new Set(), // id позиций с раскрытым редактором количества
  ocr: null, // { billId, busy, progress, status, error, raw }
  photo: null, // { billId, url }
  lastKey: '',
  lastBillId: null,
  focus: null, // селектор элемента, который нужно сфокусировать после отрисовки
};

// ---------- утилиты ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (c) => (c / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Целые суммы — без копеек: 329 вместо 329,00.
const fmtR = (c) => (c % 100 ? fmt(c) : (c / 100).toLocaleString('ru-RU'));
const cur = () => S.data().settings.currency || '';
const fmtDate = (ts) => new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
const go = (h) => (location.hash = h);
const findItem = (bill, id) => bill.items.find((i) => i.id === id);
// Доля для показа: 2, 0,5 → «1/2», 0,25 → «1/4», 0,333… → «1/3».
function fmtW(w) {
  if (Number.isInteger(w)) return String(w);
  for (let d = 2; d <= 12; d++) {
    const n = Math.round(w * d);
    if (Math.abs(n / d - w) < 1e-9) return `${n}/${d}`;
  }
  return String(Math.round(w * 1000) / 1000).replace('.', ',');
}

function route() {
  const [a, b, c] = location.hash.replace(/^#\/?/, '').split('/');
  if (a === 'bill' && b) return { name: 'bill', id: b, tab: c || 'people' };
  if (a === 'directory') return { name: 'directory' };
  if (a === 'family' && b) return { name: 'family', id: b, billId: c || null };
  if (a === 'settings') return { name: 'settings' };
  return { name: 'bills' };
}

function curBill() {
  const r = route();
  return r.name === 'bill' ? S.getBill(r.id) : null;
}

// Участники счёта, упорядоченные по семьям.
function orderedPeople(bill) {
  return bill.families.flatMap((f) => bill.people.filter((p) => p.familyId === f.id));
}

// ---------- отрисовка ----------

function render() {
  const r = route();

  // Пустой черновик счёта, из которого ушли, — удаляем, чтобы не засорять историю.
  const inBill = (r.name === 'bill' && r.id === ui.lastBillId) || (r.name === 'family' && r.billId === ui.lastBillId);
  if (ui.lastBillId && !inBill) {
    const prev = S.getBill(ui.lastBillId);
    if (prev && S.isEmptyBill(prev)) S.deleteBill(prev.id);
    ui.lastBillId = null;
  }

  const key = `${r.name}/${r.id || ''}/${r.tab || ''}`;
  const scroll = key === ui.lastKey ? window.scrollY : 0;
  let html;
  if (r.name === 'bill') {
    const bill = S.getBill(r.id);
    if (!bill) return go('#/');
    ui.lastBillId = bill.id;
    html = billScreen(bill, r.tab);
  } else if (r.name === 'family') html = familyScreen(r.id, r.billId);
  else if (r.name === 'directory') html = directoryScreen();
  else if (r.name === 'settings') html = settingsScreen();
  else html = billsScreen();

  app.innerHTML = html;
  ui.lastKey = key;
  window.scrollTo(0, scroll);
  const bill = curBill();
  if (bill) refreshLive(bill);
  if (ui.focus) {
    app.querySelector(ui.focus)?.focus();
    ui.focus = null;
  }
}

function shell(title, body, active) {
  const tabs = [
    ['#/', 'bills', '🧾', 'Счета'],
    ['#/directory', 'directory', '👥', 'Справочник'],
    ['#/settings', 'settings', '⚙️', 'Настройки'],
  ];
  return `
    <header class="top"><h1>${title}</h1></header>
    <main>${body}</main>
    <nav class="tabbar">${tabs
      .map(([h, k, i, l]) => `<a href="${h}" class="${k === active ? 'on' : ''}"><span>${i}</span>${l}</a>`)
      .join('')}</nav>`;
}

// ---------- список счетов ----------

function billsScreen() {
  const d = S.data();
  const bills = [...d.bills].sort((a, b) => b.createdAt - a.createdAt);
  const list = bills.length
    ? bills
        .map((b) => {
          const r = computeBill(b);
          const fams = b.families.map((f) => f.name).join(', ') || 'участники не выбраны';
          return `
          <div class="card bill-row" data-act="openBill" data-id="${b.id}">
            <div class="grow">
              <div class="title">${esc(b.place || 'Без названия')}</div>
              <div class="muted small">${fmtDate(b.createdAt)} · ${esc(fams)}</div>
            </div>
            <div class="amount">${fmt(r.grandTotal)}</div>
            <button class="icon-btn" data-act="deleteBill" data-id="${b.id}" aria-label="Удалить">🗑</button>
          </div>`;
        })
        .join('')
    : `<p class="empty">Здесь будет история ваших вечеров.</p>`;

  return shell(
    'FairSum',
    `<button class="btn primary big block" data-act="newBill">＋ Новый счёт</button>
     ${d.families.length ? '' : `<p class="hint">Совет: сначала заполните <a href="#/directory">справочник</a> — семьи и участников.</p>`}
     <h2>История</h2>${list}`,
    'bills',
  );
}

// ---------- справочник ----------

function directoryScreen() {
  const d = S.data();
  const fams = d.families
    .map((f) => {
      const members = d.people.filter((p) => p.familyId === f.id);
      return `
      <div class="card">
        <div class="row">
          <div class="title grow">${esc(f.name)}</div>
          <a class="icon-btn" href="#/family/${f.id}" aria-label="Изменить">✎</a>
        </div>
        <div class="chips">
          ${members.map((p) => `<a class="chip" href="#/family/${f.id}">${esc(p.name)}</a>`).join('') || '<span class="muted small">Нет участников</span>'}
        </div>
      </div>`;
    })
    .join('');

  return shell(
    'Справочник',
    `<p class="hint">Семья — это группа, которая платит вместе. Кто пришёл один, тот «семья» из одного человека.</p>
     ${fams || '<p class="empty">Пока пусто.</p>'}
     <button class="btn block" data-act="addFamily">＋ Новая семья</button>`,
    'directory',
  );
}

// ---------- редактирование семьи ----------

function familyScreen(fid, billId) {
  const d = S.data();
  const f = d.families.find((x) => x.id === fid);
  const back = billId ? `#/bill/${billId}/people` : '#/directory';
  if (!f) return `<header class="top"><a href="${back}" class="back">‹</a><h1>Семья не найдена</h1></header>`;
  const members = d.people.filter((p) => p.familyId === fid);
  return `
    <header class="top">
      <a href="${back}" class="back" aria-label="Назад">‹</a>
      <h1 class="grow">Семья</h1>
    </header>
    <main>
      <div class="card">
        <label class="fld"><span>Название</span><input data-bind="familyName" data-fid="${fid}" value="${esc(f.name)}"></label>
      </div>
      <div class="card">
        <div class="title">Члены семьи</div>
        ${members
          .map(
            (p) => `<div class="member-row">
              <input class="grow" data-bind="personName" data-pid="${p.id}" value="${esc(p.name)}" placeholder="Имя">
              <button class="icon-btn" data-act="deletePerson" data-pid="${p.id}" aria-label="Удалить">🗑</button>
            </div>`,
          )
          .join('') || '<p class="muted">Нет участников.</p>'}
        <button class="btn block" data-act="addMember" data-fid="${fid}">＋ Добавить члена семьи</button>
      </div>
      <a class="btn primary block" href="${back}">Готово</a>
      <button class="link danger block-link" data-act="deleteFamily" data-id="${fid}">Удалить семью</button>
    </main>`;
}

// Исправленные в справочнике имена переносятся во все счета.
function syncNames() {
  const d = S.data();
  const fam = Object.fromEntries(d.families.map((f) => [f.id, f.name]));
  const ppl = Object.fromEntries(d.people.map((p) => [p.id, p.name]));
  for (const b of d.bills) {
    for (const f of b.families) if (fam[f.id]) f.name = fam[f.id];
    for (const p of b.people) if (ppl[p.id]) p.name = ppl[p.id];
  }
}

// ---------- настройки ----------

function settingsScreen() {
  const s = S.data().settings;
  const langs = s.ocrLangs.split('+');
  const langBox = (code, label) =>
    `<label class="check"><input type="checkbox" data-lang="${code}" ${langs.includes(code) ? 'checked' : ''}> ${label}</label>`;
  return shell(
    'Настройки',
    `<div class="card">
       <label class="fld"><span>Валюта (подпись)</span><input data-bind="setting" data-key="currency" value="${esc(s.currency)}"></label>
     </div>
     <div class="card">
       <div class="title">Языки распознавания чеков</div>
       <p class="muted small">Чем меньше языков, тем быстрее распознавание. Языковые файлы скачиваются один раз.</p>
       ${langBox('rus', 'Русский')} ${langBox('ron', 'Румынский')} ${langBox('eng', 'Английский')}
     </div>
     <div class="card">
       <div class="title">Резервная копия</div>
       <p class="muted small">Все данные хранятся только на этом телефоне. Сохраните копию, чтобы перенести их на другой телефон.</p>
       <div class="row gap">
         <button class="btn grow" data-act="exportData">Сохранить копию</button>
         <label class="btn grow">Восстановить<input type="file" accept="application/json,.json" data-file="import" hidden></label>
       </div>
     </div>
     <div class="card">
       <div class="title">Установка на телефон</div>
       <p class="small"><b>iPhone (Safari):</b> кнопка «Поделиться» → «На экран „Домой“».<br>
       <b>Android (Chrome):</b> меню ⋮ → «Добавить на главный экран» / «Установить приложение».</p>
     </div>
     <p class="muted small center">FairSum · данные не покидают телефон</p>`,
    'settings',
  );
}

// ---------- экран счёта ----------

const BILL_TABS = [
  ['people', 'Кто'],
  ['items', 'Позиции'],
  ['pay', 'Оплата'],
  ['result', 'Итог'],
];

function billScreen(bill, tab) {
  const idx = Math.max(0, BILL_TABS.findIndex(([k]) => k === tab));
  tab = BILL_TABS[idx][0];
  const body = { people: peopleTab, items: itemsTab, pay: payTab, result: resultTab }[tab](bill);
  const next = BILL_TABS[idx + 1];
  return `
    <header class="top">
      <a href="#/" class="back" aria-label="Назад">‹</a>
      <h1 class="grow" data-live="place"></h1>
      <span class="muted small">${fmtDate(bill.createdAt)}</span>
    </header>
    <nav class="seg tabs">${BILL_TABS.map(
      ([k, l]) => `<a href="#/bill/${bill.id}/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`,
    ).join('')}</nav>
    <main class="bill">${body}
      ${next ? `<a class="btn primary block next" href="#/bill/${bill.id}/${next[0]}">Далее: ${next[1]} →</a>` : ''}
    </main>`;
}

// --- вкладка «Кто» ---

function peopleTab(bill) {
  const d = S.data();
  const inBill = new Set(bill.people.map((p) => p.id));
  const fams = d.families.map((f) => ({ id: f.id, name: f.name }));
  for (const f of bill.families) if (!fams.some((x) => x.id === f.id)) fams.push(f);

  const membersOf = (fid) => {
    const list = d.people.filter((p) => p.familyId === fid);
    for (const p of bill.people) if (p.familyId === fid && !list.some((x) => x.id === p.id)) list.push(p);
    return list;
  };

  const cards = fams
    .map((f) => {
      const members = membersOf(f.id);
      const n = members.filter((p) => inBill.has(p.id)).length;
      const mark = n === 0 ? '○' : n === members.length ? '✓' : '◐';
      return `
      <div class="card fam ${n ? 'sel' : ''}">
        <button class="fam-head" data-act="toggleFam" data-fid="${f.id}">
          <span class="mark">${mark}</span><span class="title grow">${esc(f.name)}</span>
          <span class="muted small">${n}/${members.length}</span>
        </button>
        ${d.families.some((x) => x.id === f.id) ? `<a class="icon-btn fam-edit" href="#/family/${f.id}/${bill.id}" aria-label="Изменить семью">✎</a>` : ''}
        <div class="chips">${members
          .map(
            (p) =>
              `<button class="chip ${inBill.has(p.id) ? 'on' : ''}" data-act="togglePerson" data-pid="${p.id}" data-fid="${f.id}">${esc(p.name)}</button>`,
          )
          .join('')}</div>
      </div>`;
    })
    .join('');

  const hasPrev = S.data().bills.some((b) => b.id !== bill.id && b.people.length);

  return `
    <div class="card">
      <label class="fld"><span>Где были</span><input data-bind="place" value="${esc(bill.place)}" placeholder="Название ресторана (необязательно)"></label>
    </div>
    ${hasPrev ? `<button class="btn block" data-act="copyLast">↺ Те же, что в прошлый раз</button>` : ''}
    ${cards || '<p class="empty">Справочник пуст — добавьте участника кнопкой ниже.</p>'}
    <button class="btn block" data-act="addGuest">＋ Новый участник</button>`;
}

// --- вкладка «Позиции» ---

function itemsTab(bill) {
  const ocr = ui.ocr?.billId === bill.id ? ui.ocr : null;
  const photo = ui.photo?.billId === bill.id ? ui.photo.url : null;
  const people = orderedPeople(bill);

  const ocrBlock = `
    <div class="card">
      <div class="row gap">
        <label class="btn primary grow ${ocr?.busy ? 'disabled' : ''}">📷 Камера
          <input type="file" accept="image/*" capture="environment" data-file="receipt" hidden ${ocr?.busy ? 'disabled' : ''}></label>
        <label class="btn grow ${ocr?.busy ? 'disabled' : ''}">🖼 Галерея
          <input type="file" accept="image/*" data-file="receipt" hidden ${ocr?.busy ? 'disabled' : ''}></label>
      </div>
      ${ocr?.busy ? `<div class="progress"><div class="bar" id="ocrBar" style="width:${Math.round(ocr.progress * 100)}%"></div></div>
        <div class="muted small" id="ocrStatus">${esc(ocr.status)}</div>` : ''}
      ${ocr?.error ? `<p class="warn">${esc(ocr.error)}</p>` : ''}
      ${photo ? `<details><summary>Фото счёта</summary><img class="receipt" src="${photo}" alt="Фото счёта"></details>` : ''}
      ${ocr?.raw ? `<details><summary>Распознанный текст</summary><pre>${esc(ocr.raw)}</pre></details>` : ''}
      <div class="sum-line"><span>Сумма позиций</span><b data-live="itemsTotal"></b></div>
      ${bill.receiptTotal != null ? `
        <div class="sum-line"><span>Итог на чеке</span>
          <span><input class="amount-in" inputmode="decimal" data-bind="receiptTotal" value="${esc(bill.receiptTotal)}"></span></div>` : ''}
      <div data-live="receiptCheck"></div>
    </div>`;

  if (!people.length) {
    return `${ocrBlock}<p class="warn">Сначала выберите участников на вкладке <a href="#/bill/${bill.id}/people">«Кто»</a>.</p>
      ${bill.items.length ? `<p class="muted small">Позиций: ${bill.items.length}</p>` : ''}`;
  }

  const items = bill.items
    .map((it) => {
      const none = !people.some((p) => (it.shares[p.id] || 0) > 0);
      const exp = ui.expanded.has(it.id);
      return `
      <div class="card item ${none ? 'bad' : ''}">
        <div class="row gap">
          <input class="grow" data-bind="itemName" data-iid="${it.id}" value="${esc(it.name)}" placeholder="Название">
          <input class="amount-in" inputmode="decimal" data-bind="itemAmount" data-iid="${it.id}" value="${esc(it.amount)}" placeholder="0.00">
        </div>
        <div class="chips">${people
          .map((p) => {
            const w = it.shares[p.id] || 0;
            return `<button class="chip ${w > 0 ? 'on' : ''}" data-act="toggleShare" data-iid="${it.id}" data-pid="${p.id}">${esc(p.name)}</button>`;
          })
          .join('')}</div>
        ${none ? '<div class="small bad-text">Отметьте, кто это ел или пил</div>' : ''}
        ${exp ? shareEditor(bill, it, people) : ''}
        <div class="row item-tools">
          <button class="link" data-act="expandItem" data-iid="${it.id}">${exp ? 'Свернуть' : 'Поделить неравно…'}</button>
        </div>
      </div>`;
    })
    .join('');

  return `${ocrBlock}
    ${items || '<p class="empty">Сфотографируйте счёт или добавьте позиции вручную.</p>'}
    <button class="btn block" data-act="addItem">＋ Добавить позицию</button>
    ${bill.items.length ? `<button class="link danger block-link" data-act="clearItems">Удалить все позиции</button>` : ''}`;
}

function shareEditor(bill, it, people) {
  return `
    <div class="share-editor">
      <div class="chips">
        <button class="chip ghost" data-act="shareAll" data-iid="${it.id}">Все</button>
        <button class="chip ghost" data-act="shareNone" data-iid="${it.id}">Никто</button>
        ${bill.families
          .map((f) => `<button class="chip ghost" data-act="shareFam" data-iid="${it.id}" data-fid="${f.id}">${esc(f.name)}</button>`)
          .join('')}
      </div>
      ${people
        .map((p) => {
          const w = it.shares[p.id] || 0;
          return `<div class="stepper-row">
            <span class="grow">${esc(p.name)}</span>
            <button class="step" data-act="step" data-iid="${it.id}" data-pid="${p.id}" data-d="-1">−</button>
            <input class="w-in" inputmode="text" data-bind="weight" data-iid="${it.id}" data-pid="${p.id}" value="${w ? fmtW(w) : ''}" placeholder="0">
            <button class="step" data-act="step" data-iid="${it.id}" data-pid="${p.id}" data-d="1">＋</button>
            <span class="share-amt muted" data-share="${it.id}:${p.id}"></span>
          </div>`;
        })
        .join('')}
    </div>`;
}

// --- вкладка «Оплата» ---

function tipField(bill) {
  return `
    <div class="card">
      <div class="title">Чаевые</div>
      <div class="row gap">
        <input class="grow" inputmode="decimal" data-bind="extra" data-key="tip" value="${esc(bill.tip.value)}" placeholder="0">
        <span class="muted">${esc(cur())}</span>
      </div>
      <div class="muted small" data-live="tipHint"></div>
    </div>`;
}

function extraField(key, label, spec) {
  return `
    <div class="card">
      <div class="row">
        <div class="title grow">${label}</div>
        <div class="seg small-seg">
          <button class="${spec.mode !== 'amount' ? 'on' : ''}" data-act="setMode" data-key="${key}" data-mode="percent">%</button>
          <button class="${spec.mode === 'amount' ? 'on' : ''}" data-act="setMode" data-key="${key}" data-mode="amount">${esc(cur() || 'сумма')}</button>
        </div>
      </div>
      <div class="row gap">
        <input class="grow" inputmode="decimal" data-bind="extra" data-key="${key}" value="${esc(spec.value)}" placeholder="0">
        <span class="muted" data-live="${key}Hint"></span>
      </div>
    </div>`;
}

function payTab(bill) {
  // Раньше была кнопка «оплатили весь счёт» — переводим такие счета в обычную сумму оплаты.
  if (bill.fullPayer) {
    const total = computeBill(bill).grandTotal;
    bill.payments = { [bill.fullPayer]: (total / 100).toFixed(2) };
    bill.fullPayer = null;
    S.save();
  }
  const payers = bill.families
    .map(
      (f) => `<div class="pay-row"><span class="grow">${esc(f.name)}</span>
        <input class="amount-in" inputmode="decimal" data-bind="payment" data-fid="${f.id}" value="${esc(bill.payments[f.id] ?? '')}" placeholder="0"></div>`,
    )
    .join('');

  return `
    ${tipField(bill)}
    <details class="card" ${parseNum(bill.service.value) || parseNum(bill.discount.value) ? 'open' : ''}>
      <summary class="title">Обслуживание и скидка в счёте</summary>
      ${extraField('service', 'Обслуживание (сервисный сбор)', bill.service)}
      ${extraField('discount', 'Скидка', bill.discount)}
    </details>
    <div class="card totals">
      <div class="sum-line"><span>Позиции</span><b data-live="itemsTotal"></b></div>
      <div class="sum-line"><span>Обслуживание</span><span data-live="service"></span></div>
      <div class="sum-line"><span>Скидка</span><span data-live="discount"></span></div>
      <div class="sum-line"><span>Чаевые</span><span data-live="tip"></span></div>
      <div class="sum-line grand"><span>Итого</span><b data-live="grandTotal"></b></div>
    </div>
    <div class="card">
      <div class="title">Кто платил</div>
      ${payers || '<p class="muted">Нет участников.</p>'}
      <div class="sum-line"><span>Оплачено</span><b data-live="paid"></b></div>
      <div data-live="payWarn"></div>
    </div>`;
}

// --- вкладка «Итог» ---

function warnings(bill, r) {
  const w = [];
  if (!bill.people.length) w.push('Не выбраны участники.');
  if (!bill.items.length) w.push('Нет позиций.');
  if (r.unassigned) w.push(`Не распределено ${fmt(r.unassigned)} — у некоторых позиций не отмечено, кто ел.`);
  if (!r.paidTotal && bill.families.length) w.push('Не указано, кто платил — переводы не рассчитаны.');
  else if (r.paidTotal && r.paidTotal !== r.grandTotal)
    w.push(`Оплачено ${fmt(r.paidTotal)}, а итог ${fmt(r.grandTotal)}.`);
  return w;
}

// Глава семьи — первый участник семьи в справочнике (если семьи там уже нет — первый в счёте).
function familyHeads(bill) {
  const d = S.data();
  return Object.fromEntries(
    bill.families.map((f) => {
      const p = d.people.find((x) => x.familyId === f.id) || bill.people.find((x) => x.familyId === f.id);
      return [f.id, p?.name || f.name];
    }),
  );
}

// «по счёту 30+140+30+100 = 300» — доля семьи в каждой позиции в порядке позиций в счёте.
function familySums(bill, r) {
  const famOf = Object.fromEntries(bill.people.map((p) => [p.id, p.familyId]));
  const perItem = Object.fromEntries(bill.families.map((f) => [f.id, []]));
  for (const it of bill.items) {
    const byFam = {};
    for (const [pid, c] of Object.entries(splitItem(it, bill.people))) byFam[famOf[pid]] = (byFam[famOf[pid]] || 0) + c;
    for (const [fid, c] of Object.entries(byFam)) if (c && perItem[fid]) perItem[fid].push(c);
  }
  return Object.fromEntries(
    r.rows.map((row) => {
      let sum = perItem[row.id].map(fmtR).join('+') || '0';
      if (row.service) sum += ` + обсл. ${fmtR(row.service)}`;
      if (row.discount) sum += ` − скидка ${fmtR(row.discount)}`;
      return [row.id, `по счёту ${sum} = ${fmtR(row.owed - row.tip)}`];
    }),
  );
}

function resultTab(bill) {
  const r = computeBill(bill);
  const head = familyHeads(bill);
  const warn = warnings(bill, r);

  const sums = familySums(bill, r);
  const cards = r.rows
    .map((row) => {
      return `
      <div class="card fam-res">
        <div class="fam-line"><span class="title">${esc(row.name)}</span> — ${row.tip ? 'с чаевыми' : 'к оплате'} <b>${fmtR(row.owed)}</b></div>
        <div class="fam-sum">${esc(sums[row.id])}</div>
        ${row.paid ? `<div class="small">Заплатили: ${fmt(row.paid)}</div>` : ''}
        ${row.members.length > 1 ? `<details><summary class="small">По участникам (без чаевых)</summary>
          ${row.members.map((m) => `<div class="sum-line small"><span>${esc(m.name)}</span><span>${fmt(m.food)}</span></div>`).join('')}
        </details>` : ''}
      </div>`;
    })
    .join('');

  let transfers = '';
  if (r.paidTotal) {
    transfers = r.transfers.length
      ? r.transfers
          .map(
            (t) => `<div class="transfer"><b>${esc(head[t.from])}</b><span class="arrow">→</span><b>${esc(head[t.to])}</b>
              <span class="grow"></span><b>${fmtR(t.amount)}</b></div>`,
          )
          .join('')
      : '<p>Все в расчёте 👍</p>';
    transfers = `<h2>Кто кому переводит</h2><div class="card">${transfers}</div>`;
  }

  return `
    ${warn.map((x) => `<p class="warn">${esc(x)}</p>`).join('')}
    <div class="card totals">
      <div class="sum-line grand"><span>Итого по счёту</span><b>${fmt(r.grandTotal)} ${esc(cur())}</b></div>
    </div>
    <h2>К оплате по семьям</h2>
    ${cards}
    ${transfers}
    <button class="btn primary block" data-act="copy">Копировать</button>`;
}

function shareText(bill) {
  const r = computeBill(bill);
  const head = familyHeads(bill);
  const c = cur() ? ' ' + cur() : '';
  const sums = familySums(bill, r);
  const lines = [`🧾 ${bill.place || 'Счёт'}, ${fmtDate(bill.createdAt)}`, `Итого по счёту: ${fmtR(r.grandTotal)}${c}`];
  for (const row of r.rows) {
    lines.push('', `${row.name} — ${row.tip ? 'с чаевыми' : 'к оплате'} ${fmtR(row.owed)}${c}`, sums[row.id]);
    if (row.paid) lines.push(`Заплатили: ${fmtR(row.paid)}`);
  }
  if (r.transfers.length) {
    lines.push('', 'Кто кому переводит:');
    for (const t of r.transfers) lines.push(`${head[t.from]} → ${head[t.to]}: ${fmtR(t.amount)}${c}`);
  }
  return lines.join('\n');
}

// ---------- «живые» значения (обновляются при вводе без перерисовки) ----------

function refreshLive(bill) {
  const r = computeBill(bill);
  const hint = (spec, cents) => (spec.mode === 'amount' ? '' : cents ? `= ${fmt(cents)}` : '');
  let receiptCheck = '';
  if (bill.receiptTotal != null && bill.items.length) {
    const rt = toCents(bill.receiptTotal);
    const ok = rt === r.itemsTotal || rt === r.itemsTotal + r.service - r.discount;
    receiptCheck = ok
      ? '<p class="ok">✓ Сумма позиций совпадает с чеком</p>'
      : `<p class="warn">Сумма позиций ${r.itemsTotal > rt ? 'больше' : 'меньше'} итога на чеке на ${fmt(Math.abs(rt - r.itemsTotal))} — проверьте позиции (сравните с фото).</p>`;
  }
  const vals = {
    place: esc(bill.place || 'Новый счёт'),
    itemsTotal: fmt(r.itemsTotal),
    receiptCheck,
    service: r.service ? '+' + fmt(r.service) : '—',
    discount: r.discount ? '−' + fmt(r.discount) : '—',
    tip: r.tip ? '+' + fmt(r.tip) : '—',
    grandTotal: `${fmt(r.grandTotal)} ${esc(cur())}`,
    tipHint: r.tip && r.itemsTotal
      ? `≈ ${(Math.round((r.tip * 1000) / (r.itemsTotal + r.service - r.discount || 1)) / 10).toLocaleString('ru-RU')}% от счёта`
      : '',
    serviceHint: hint(bill.service, r.service),
    discountHint: hint(bill.discount, r.discount),
    paid: `${fmt(r.paidTotal)} из ${fmt(r.grandTotal)}`,
    payWarn:
      r.paidTotal && r.paidTotal !== r.grandTotal
        ? `<p class="warn">${r.paidTotal > r.grandTotal ? 'Переплата' : 'Не хватает'}: ${fmt(Math.abs(r.grandTotal - r.paidTotal))}</p>`
        : '',
  };
  // Сколько приходится на каждого в позициях с неравным делением.
  const splits = {};
  app.querySelectorAll('[data-share]').forEach((n) => {
    const [iid, pid] = n.dataset.share.split(':');
    const it = findItem(bill, iid);
    if (!it) return;
    splits[iid] ??= splitItem(it, bill.people);
    n.textContent = splits[iid][pid] ? fmt(splits[iid][pid]) : '';
  });
  app.querySelectorAll('[data-live]').forEach((n) => {
    const v = vals[n.dataset.live];
    if (v !== undefined) n.innerHTML = v;
  });
}

// ---------- диалог с формой ----------

function form({ title, fields, ok = 'Сохранить', extra }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `
      <form method="dialog">
        <h3>${esc(title)}</h3>
        ${fields
          .map(
            (f) => `<label class="fld"><span>${esc(f.label)}</span>${
              f.type === 'select'
                ? `<select name="${f.name}">${f.options
                    .map((o) => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`)
                    .join('')}</select>`
                : `<input name="${f.name}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="off">`
            }</label>`,
          )
          .join('')}
        <div class="row gap dlg-btns">
          ${extra ? `<button value="extra" class="btn danger">${esc(extra)}</button>` : ''}
          <span class="grow"></span>
          <button value="cancel" class="btn">Отмена</button>
          <button value="ok" class="btn primary">${esc(ok)}</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    const formEl = dlg.querySelector('form');
    // Enter в поле — «Сохранить», а не первая кнопка формы (которая может быть «Удалить»).
    formEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        e.preventDefault();
        dlg.close('ok');
      }
    });
    dlg.addEventListener('close', () => {
      const v = dlg.returnValue;
      const values = Object.fromEntries(new FormData(formEl));
      dlg.remove();
      resolve(v === 'ok' ? values : v === 'extra' ? 'extra' : null);
    });
    dlg.showModal();
    dlg.querySelector('input')?.focus();
  });
}

// ---------- изменения данных ----------

function addPersonToBill(bill, person, family) {
  if (!bill.people.some((p) => p.id === person.id))
    bill.people.push({ id: person.id, name: person.name, familyId: family.id });
  if (!bill.families.some((f) => f.id === family.id)) bill.families.push({ id: family.id, name: family.name });
}

function removePersonFromBill(bill, pid) {
  const p = bill.people.find((x) => x.id === pid);
  if (!p) return;
  bill.people = bill.people.filter((x) => x.id !== pid);
  for (const it of bill.items) delete it.shares[pid];
  if (!bill.people.some((x) => x.familyId === p.familyId)) {
    bill.families = bill.families.filter((f) => f.id !== p.familyId);
    delete bill.payments[p.familyId];
    if (bill.fullPayer === p.familyId) bill.fullPayer = null;
  }
}

function newItem(bill, name = '', amount = '') {
  return {
    id: S.uid(),
    name,
    amount,
    shares: Object.fromEntries(bill.people.map((p) => [p.id, 1])),
  };
}

function keepDistribution(oldItems, fresh) {
  const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const pool = oldItems.map((it, i) => ({ it, i, used: false }));
  const take = (pred) => {
    const m = pool.find((o) => !o.used && pred(o));
    if (m) m.used = true;
    return m?.it;
  };
  return fresh.map((nw, i) => {
    const c = toCents(nw.amount);
    const same = (o) => toCents(o.it.amount) === c;
    return (
      take((o) => same(o) && norm(o.it.name) === norm(nw.name)) ||
      take((o) => same(o) && o.i === i) ||
      nw
    );
  });
}

function familyOptions(withNew) {
  const opts = S.data().families.map((f) => ({ value: f.id, label: f.name }));
  if (withNew) opts.unshift({ value: '__new', label: '➕ Новая семья (по имени участника)' });
  return opts;
}

const actions = {
  // --- счета ---
  newBill() {
    const b = S.newBill();
    go(`#/bill/${b.id}/people`);
  },
  openBill(el) {
    const b = S.getBill(el.dataset.id);
    const tab = !b.people.length ? 'people' : !b.items.length ? 'items' : 'result';
    go(`#/bill/${b.id}/${tab}`);
  },
  deleteBill(el) {
    if (confirm('Удалить этот счёт из истории?')) {
      S.deleteBill(el.dataset.id);
      render();
    }
  },

  // --- справочник ---
  async addFamily() {
    const v = await form({
      title: 'Новая семья',
      fields: [
        { name: 'name', label: 'Название', placeholder: 'Например: Ивановы' },
        { name: 'members', label: 'Участники через запятую', placeholder: 'Игорь, Аня, Маша' },
      ],
      ok: 'Добавить',
    });
    if (!v) return;
    const members = v.members.split(',').map((s) => s.trim()).filter(Boolean);
    const name = v.name.trim() || members[0];
    if (!name) return;
    const d = S.data();
    const f = { id: S.uid(), name };
    d.families.push(f);
    for (const m of members) d.people.push({ id: S.uid(), name: m, familyId: f.id });
    S.save();
    render();
  },
  deleteFamily(el) {
    const d = S.data();
    const f = d.families.find((x) => x.id === el.dataset.id);
    if (!confirm(`Удалить семью «${f.name}» и всех её участников из справочника? История счетов сохранится.`)) return;
    d.families = d.families.filter((x) => x.id !== f.id);
    d.people = d.people.filter((p) => p.familyId !== f.id);
    S.save();
    const r = route();
    go(r.billId ? `#/bill/${r.billId}/people` : '#/directory');
  },
  async addMember(el) {
    const v = await form({ title: 'Новый член семьи', fields: [{ name: 'name', label: 'Имя' }], ok: 'Добавить' });
    if (!v || !v.name.trim()) return;
    S.data().people.push({ id: S.uid(), name: v.name.trim(), familyId: el.dataset.fid });
    S.save();
    render();
  },
  deletePerson(el) {
    const d = S.data();
    const p = d.people.find((x) => x.id === el.dataset.pid);
    if (!confirm(`Удалить «${p.name}» из справочника? История счетов сохранится.`)) return;
    d.people = d.people.filter((x) => x.id !== p.id);
    S.save();
    render();
  },

  // --- участники счёта ---
  togglePerson(el, bill) {
    const pid = el.dataset.pid;
    if (bill.people.some((p) => p.id === pid)) removePersonFromBill(bill, pid);
    else {
      const d = S.data();
      const person = d.people.find((p) => p.id === pid);
      const family = d.families.find((f) => f.id === el.dataset.fid) || bill.families.find((f) => f.id === el.dataset.fid);
      if (person && family) addPersonToBill(bill, person, family);
    }
    S.save();
    render();
  },
  toggleFam(el, bill) {
    const d = S.data();
    const fid = el.dataset.fid;
    const family = d.families.find((f) => f.id === fid) || bill.families.find((f) => f.id === fid);
    const members = d.people.filter((p) => p.familyId === fid);
    const anyIn = bill.people.some((p) => p.familyId === fid) || members.some((m) => bill.people.some((p) => p.id === m.id));
    if (anyIn) {
      for (const p of [...bill.people]) if (p.familyId === fid) removePersonFromBill(bill, p.id);
    } else {
      for (const m of members) addPersonToBill(bill, m, family);
    }
    S.save();
    render();
  },
  copyLast(el, bill) {
    const prev = [...S.data().bills]
      .filter((b) => b.id !== bill.id && b.people.length)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!prev) return;
    for (const p of [...bill.people]) removePersonFromBill(bill, p.id);
    bill.people = prev.people.map((p) => ({ ...p }));
    bill.families = prev.families.map((f) => ({ ...f }));
    S.save();
    render();
  },
  async addGuest(el, bill) {
    const v = await form({
      title: 'Новый участник',
      fields: [
        { name: 'name', label: 'Имя' },
        { name: 'familyId', label: 'Семья', type: 'select', options: familyOptions(true), value: '__new' },
      ],
      ok: 'Добавить',
    });
    if (!v || !v.name.trim()) return;
    const d = S.data();
    let family = d.families.find((f) => f.id === v.familyId);
    if (!family) {
      family = { id: S.uid(), name: v.name.trim() };
      d.families.push(family);
    }
    const person = { id: S.uid(), name: v.name.trim(), familyId: family.id };
    d.people.push(person);
    addPersonToBill(bill, person, family);
    S.save();
    render();
  },

  // --- позиции ---
  addItem(el, bill) {
    const it = newItem(bill);
    bill.items.push(it);
    S.save();
    ui.focus = `input[data-bind="itemName"][data-iid="${it.id}"]`;
    render();
  },
  clearItems(el, bill) {
    if (!confirm('Удалить все позиции этого счёта?')) return;
    bill.items = [];
    bill.receiptTotal = null;
    S.save();
    render();
  },
  expandItem(el) {
    const id = el.dataset.iid;
    ui.expanded.has(id) ? ui.expanded.delete(id) : ui.expanded.add(id);
    render();
  },
  toggleShare(el, bill) {
    const it = findItem(bill, el.dataset.iid);
    const pid = el.dataset.pid;
    it.shares[pid] = (it.shares[pid] || 0) > 0 ? 0 : 1;
    S.save();
    render();
  },
  step(el, bill) {
    const it = findItem(bill, el.dataset.iid);
    const pid = el.dataset.pid;
    const w = (it.shares[pid] || 0) + Number(el.dataset.d);
    it.shares[pid] = w > 0 ? Math.round(w * 1e6) / 1e6 : 0;
    S.save();
    render();
  },
  shareAll(el, bill) {
    const it = findItem(bill, el.dataset.iid);
    for (const p of bill.people) it.shares[p.id] = 1;
    S.save();
    render();
  },
  shareNone(el, bill) {
    findItem(bill, el.dataset.iid).shares = {};
    S.save();
    render();
  },
  shareFam(el, bill) {
    const it = findItem(bill, el.dataset.iid);
    const members = bill.people.filter((p) => p.familyId === el.dataset.fid);
    const allOn = members.every((p) => (it.shares[p.id] || 0) > 0);
    for (const p of members) it.shares[p.id] = allOn ? 0 : 1;
    S.save();
    render();
  },

  // --- оплата ---
  setMode(el, bill) {
    bill[el.dataset.key].mode = el.dataset.mode;
    S.save();
    render();
  },

  // --- итог ---
  async copy(el, bill) {
    const text = shareText(bill);
    try {
      await navigator.clipboard.writeText(text);
      toast('Скопировано');
    } catch {
      prompt('Скопируйте текст:', text);
    }
  },

  // --- настройки ---
  async exportData() {
    const json = JSON.stringify(S.data(), null, 2);
    const name = `fairsum-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'FairSum — резервная копия' });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
};

function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

// ---------- распознавание чека ----------

async function onReceiptPhoto(file, bill) {
  if (ui.photo?.url) URL.revokeObjectURL(ui.photo.url);
  ui.photo = { billId: bill.id, url: URL.createObjectURL(file) };
  ui.ocr = { billId: bill.id, busy: true, progress: 0, status: 'Обработка фото…' };
  render();

  try {
    let res = null;
    const texts = await recognize(
      file,
      S.data().settings.ocrLangs,
      ({ status, progress }) => {
        ui.ocr.status = status;
        ui.ocr.progress = progress;
        const bar = document.getElementById('ocrBar');
        const st = document.getElementById('ocrStatus');
        if (bar) bar.style.width = Math.round(progress * 100) + '%';
        if (st) st.textContent = status;
      },
      // Останавливаемся, как только сумма позиций сошлась с итогом чека.
      (texts) => (res = bestParse(texts)).matched,
    );
    res = res || bestParse(texts);
    ui.ocr.raw = texts.map((t, i) => `——— вариант ${i + 1} ———\n${t}`).join('\n');
    if (!res.items.length) {
      ui.ocr.error = 'Не удалось найти позиции. Попробуйте переснять ровнее и при хорошем свете или добавьте позиции вручную.';
    } else {
      // Новый снимок счёта заменяет позиции, но уже распределённые блюда
      // (та же сумма и то же название или место в списке) сохраняют распределение и правки.
      bill.items = keepDistribution(
        bill.items,
        res.items.map((x) => newItem(bill, x.name || 'Позиция', x.amount.toFixed(2))),
      );
      bill.receiptTotal = res.total != null ? res.total.toFixed(2) : null;
      S.save();
    }
  } catch (e) {
    console.error(e);
    ui.ocr.error = e.message || String(e);
  } finally {
    ui.ocr.busy = false;
    if (curBill()?.id === bill.id) render();
  }
}

// ---------- обработчики событий ----------

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !app.contains(el)) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  try {
    await fn(el, curBill());
  } catch (err) {
    console.error(err);
    alert('Ошибка: ' + err.message);
  }
});

const binds = {
  place: (el, b) => (b.place = el.value),
  itemName: (el, b) => (findItem(b, el.dataset.iid).name = el.value),
  itemAmount: (el, b) => {
    findItem(b, el.dataset.iid).amount = el.value;
    el.classList.toggle('invalid', el.value.trim() !== '' && !Number.isFinite(parseNum(el.value)));
  },
  weight: (el, b) => {
    const w = parseWeight(el.value);
    el.classList.toggle('invalid', Number.isNaN(w));
    if (!Number.isNaN(w)) findItem(b, el.dataset.iid).shares[el.dataset.pid] = w;
  },
  receiptTotal: (el, b) => (b.receiptTotal = el.value),
  extra: (el, b) => (b[el.dataset.key].value = el.value),
  payment: (el, b) => (b.payments[el.dataset.fid] = el.value),
  setting: (el) => (S.data().settings[el.dataset.key] = el.value),
  familyName: (el) => {
    const f = S.data().families.find((x) => x.id === el.dataset.fid);
    if (f && el.value.trim()) f.name = el.value.trim();
    syncNames();
  },
  personName: (el) => {
    const p = S.data().people.find((x) => x.id === el.dataset.pid);
    if (p && el.value.trim()) p.name = el.value.trim();
    syncNames();
  },
};

document.addEventListener('input', (e) => {
  const el = e.target;
  const fn = binds[el.dataset?.bind];
  if (!fn) return;
  const bill = curBill();
  fn(el, bill);
  S.save();
  if (bill) refreshLive(bill);
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.lang) {
    const langs = [...app.querySelectorAll('input[data-lang]:checked')].map((x) => x.dataset.lang);
    if (!langs.length) {
      el.checked = true;
      return alert('Нужен хотя бы один язык.');
    }
    S.data().settings.ocrLangs = langs.join('+');
    S.save();
    return;
  }
  if (el.dataset.bind === 'weight') return render();
  if (el.dataset.file === 'receipt' && el.files?.[0]) {
    const bill = curBill();
    const file = el.files[0];
    el.value = '';
    if (bill) await onReceiptPhoto(file, bill);
    return;
  }
  if (el.dataset.file === 'import' && el.files?.[0]) {
    try {
      const obj = JSON.parse(await el.files[0].text());
      if (!Array.isArray(obj.families) || !Array.isArray(obj.people) || !Array.isArray(obj.bills))
        throw new Error('Это не резервная копия FairSum');
      if (confirm('Заменить все текущие данные данными из копии?')) {
        S.replaceAll(obj);
        render();
        toast('Данные восстановлены');
      }
    } catch (err) {
      alert('Не удалось восстановить: ' + err.message);
    }
    el.value = '';
  }
});

window.addEventListener('hashchange', render);

// ---------- запуск ----------

// Раньше чаевые можно было задать процентом — переводим старые счета в сумму, не меняя итогов.
{
  let changed = false;
  for (const b of S.data().bills) {
    if (b.tip?.mode === 'amount') continue;
    const r = computeBill(b);
    b.tip = { mode: 'amount', value: r.tip ? (r.tip / 100).toFixed(2) : '' };
    changed = true;
  }
  delete S.data().settings.defaultTip;
  if (changed) S.save();
}

render();
navigator.storage?.persist?.().catch(() => {});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW', e));
}

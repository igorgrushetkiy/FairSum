// Хранилище данных: всё лежит в localStorage телефона.
const KEY = 'fairsum.v1';

const defaults = () => ({
  version: 1,
  families: [], // { id, name }
  people: [],   // { id, name, familyId }
  bills: [],    // см. newBill()
  settings: { currency: 'лей', ocrLangs: 'rus+ron+eng' },
});

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const d = defaults();
      return { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) } };
    }
  } catch (e) {
    console.error('Не удалось прочитать данные', e);
  }
  return defaults();
}

export function data() {
  return state;
}

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.error(e);
    alert('Не удалось сохранить данные: ' + e.message);
  }
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function replaceAll(next) {
  const d = defaults();
  state = { ...d, ...next, settings: { ...d.settings, ...(next.settings || {}) } };
  save();
}

export function getBill(id) {
  return state.bills.find((b) => b.id === id);
}

export function newBill() {
  const b = {
    id: uid(),
    createdAt: Date.now(),
    place: '',
    // Снимок участников на момент счёта — история не ломается при правке справочника.
    people: [],   // { id, name, familyId }
    families: [], // { id, name }
    items: [],    // { id, name, amount, shares: { [personId]: weight } }
    service: { mode: 'percent', value: '' },
    discount: { mode: 'percent', value: '' },
    tip: { mode: 'amount', value: '' }, // чаевые — всегда суммой
    payments: {}, // { [familyId]: сумма строкой }
    fullPayer: null, // familyId семьи, оплатившей весь счёт
    receiptTotal: null, // итог, распознанный на чеке
  };
  state.bills.push(b);
  save();
  return b;
}

export function deleteBill(id) {
  state.bills = state.bills.filter((b) => b.id !== id);
  save();
}

export function isEmptyBill(b) {
  return !b.people.length && !b.items.length && !b.place;
}

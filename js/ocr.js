// Распознавание текста на самом телефоне (Tesseract.js, WebAssembly).
// Модуль и языковые файлы скачиваются при первом использовании и кэшируются браузером,
// дальше распознавание работает без интернета.

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

let libPromise = null;
let worker = null;
let workerLangs = null;
let progressCb = null;

function loadLib() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TESSERACT_URL;
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => {
        libPromise = null;
        s.remove();
        reject(new Error('Не удалось загрузить модуль распознавания. При первом запуске нужен интернет.'));
      };
      document.head.appendChild(s);
    });
  }
  return libPromise;
}

async function getWorker(langs) {
  const T = await loadLib();
  if (worker && workerLangs === langs) return worker;
  if (worker) {
    await worker.terminate().catch(() => {});
    worker = null;
  }
  try {
    worker = await T.createWorker(langs, 1, { logger: (m) => progressCb && progressCb(m) });
    workerLangs = langs;
    return worker;
  } catch (e) {
    worker = null;
    throw new Error('Не удалось запустить распознавание: ' + (e?.message || e));
  }
}

async function loadImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Не удалось открыть изображение'));
      img.src = URL.createObjectURL(file);
    });
  }
}

// ---------- подготовка изображения ----------

function toGray(data, n) {
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) g[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
  return g;
}

function otsu(values) {
  const hist = new Array(256).fill(0);
  for (const v of values) hist[Math.max(0, Math.min(255, v | 0))]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0, sB = 0, best = -1, T = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = values.length - wB;
    if (!wF) break;
    sB += t * hist[t];
    const d = sB / wB - (sum - sB) / wF;
    const v = wB * wF * d * d;
    if (v > best) { best = v; T = t; }
  }
  return T;
}

// Ищет на фото чек: самую большую светлую область (бумага светлее стола/скатерти).
// Возвращает рамку и для каждой строки уменьшенной копии — границы бумаги слева и справа.
function findPaper(img) {
  const k = 300 / Math.max(img.width, img.height);
  const w = Math.max(1, Math.round(img.width * k));
  const h = Math.max(1, Math.round(img.height * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const g = toGray(ctx.getImageData(0, 0, w, h).data, w * h);
  const T = otsu(g);

  const lab = new Int32Array(w * h);
  let bestL = 0, bestN = 0, L = 0;
  for (let i = 0; i < w * h; i++) {
    if (g[i] <= T || lab[i]) continue;
    L++;
    let n = 0;
    const stack = [i];
    lab[i] = L;
    while (stack.length) {
      const p = stack.pop();
      n++;
      const x = p % w, y = (p / w) | 0;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) if (q >= 0 && !lab[q] && g[q] > T) { lab[q] = L; stack.push(q); }
    }
    if (n > bestN) { bestN = n; bestL = L; }
  }

  const coverage = bestN / (w * h);
  if (coverage < 0.04) return null; // бумага не найдена — используем всё фото

  const spans = new Array(h).fill(null);
  let x0 = w, x1 = 0, y0 = h, y1 = 0;
  for (let y = 0; y < h; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < w; x++) if (lab[y * w + x] === bestL) { if (l < 0) l = x; r = x; }
    if (l < 0 || r - l < 3) continue;
    spans[y] = [l / k, (r + 1) / k];
    x0 = Math.min(x0, l); x1 = Math.max(x1, r + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1);
  }
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0 / k, y: y0 / k, w: (x1 - x0) / k, h: (y1 - y0) / k, spans, k };
}

// Адаптивная бинаризация: пиксель тёмный, если он заметно темнее среднего по окрестности.
// Справляется с тенями и неравномерным светом.
function binarize(g, W, H, win, kk) {
  const I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += g[y * W + x];
      I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row;
    }
  }
  const b = new Uint8Array(W * H);
  const mean = new Float32Array(W * H);
  const r = win >> 1;
  for (let y = 0; y < H; y++) {
    const ya = Math.max(0, y - r), yb = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const xa = Math.max(0, x - r), xb = Math.min(W, x + r + 1);
      const s = I[yb * (W + 1) + xb] - I[ya * (W + 1) + xb] - I[yb * (W + 1) + xa] + I[ya * (W + 1) + xa];
      const m = s / ((xb - xa) * (yb - ya));
      mean[y * W + x] = m;
      b[y * W + x] = g[y * W + x] < m * (1 - kk) ? 1 : 0;
    }
  }
  return { b, mean };
}

// Удаляет рамки таблиц: длинные ТОНКИЕ горизонтальные и вертикальные линии.
// Толстые штрихи (крупные жирные цифры итога) не трогаем.
function removeLines(b, W, H, minH, minV, maxThick) {
  const dark = (x, y) => x >= 0 && y >= 0 && x < W && y < H && b[y * W + x] === 1;
  const thickV = (x, y) => { let n = 1; for (let k = 1; dark(x, y - k) && k <= maxThick; k++) n++; for (let k = 1; dark(x, y + k) && k <= maxThick; k++) n++; return n; };
  const thickH = (x, y) => { let n = 1; for (let k = 1; dark(x - k, y) && k <= maxThick; k++) n++; for (let k = 1; dark(x + k, y) && k <= maxThick; k++) n++; return n; };
  const out = b.slice();
  // горизонтальные (с допуском ±2 пикселя на наклон фото)
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (!dark(x, y)) { x++; continue; }
      let e = x;
      while (e < W && (dark(e, y) || dark(e, y - 1) || dark(e, y + 1) || dark(e, y - 2) || dark(e, y + 2))) e++;
      if (e - x >= minH) for (let k = x; k < e; k++) if (dark(k, y) && thickV(k, y) <= maxThick) out[y * W + k] = 0;
      x = e + 1;
    }
  }
  // вертикальные
  for (let x = 0; x < W; x++) {
    let y = 0;
    while (y < H) {
      if (!dark(x, y)) { y++; continue; }
      let e = y;
      while (e < H && (dark(x, e) || dark(x - 1, e) || dark(x + 1, e) || dark(x - 2, e) || dark(x + 2, e))) e++;
      if (e - y >= minV) for (let k = y; k < e; k++) if (dark(x, k) && thickH(x, k) <= maxThick) out[k * W + x] = 0;
      y = e + 1;
    }
  }
  return out;
}

// Удаляет одиночные мелкие точки (остатки пунктирных линий, пыль).
// Запятые и точки внутри чисел сохраняются: рядом с ними всегда есть цифры.
function removeSpecks(b, W, H, maxSize, gap) {
  const lab = new Int32Array(W * H);
  const out = b.slice();
  let L = 0;
  const stack = [];
  const pix = [];
  for (let i = 0; i < W * H; i++) {
    if (!b[i] || lab[i]) continue;
    L++;
    lab[i] = L;
    stack.push(i);
    pix.length = 0;
    let x0 = W, x1 = 0, y0 = H, y1 = 0;
    let big = false;
    while (stack.length) {
      const p = stack.pop();
      if (!big) pix.push(p);
      const x = p % W, y = (p / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x1 - x0 >= maxSize || y1 - y0 >= maxSize) big = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (b[q] && !lab[q]) { lab[q] = L; stack.push(q); }
      }
    }
    if (big) continue;
    // Есть ли рядом чужие тёмные пиксели?
    let neighbour = false;
    for (let y = Math.max(0, y0 - gap); y <= Math.min(H - 1, y1 + gap) && !neighbour; y++)
      for (let x = Math.max(0, x0 - gap); x <= Math.min(W - 1, x1 + gap); x++) {
        const q = y * W + x;
        if (b[q] && lab[q] !== L) { neighbour = true; break; }
      }
    if (!neighbour) for (const p of pix) out[p] = 0;
  }
  return out;
}

// Вырезает чек, приводит его к стандартной ширине, убирает фон, тени и линии таблицы.
// Возвращает два варианта: «серый» (буквы с полутонами — так Tesseract обычно читает лучше)
// и чёрно-белый.
export async function preprocess(file) {
  const img = await loadImage(file);
  const paper = findPaper(img);
  const box = paper
    ? {
        x: Math.max(0, paper.x - 4),
        y: Math.max(0, paper.y - 4),
        w: Math.min(img.width, paper.w + 8),
        h: Math.min(img.height, paper.h + 8),
      }
    : { x: 0, y: 0, w: img.width, h: img.height };

  // Ширина чека ~1400 пикселей — комфортный размер символов для Tesseract.
  let s = 1400 / box.w;
  if (box.h * s > 4200) s = 4200 / box.h;
  const W = Math.round(box.w * s);
  const H = Math.round(box.h * s);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, W, H);
  img.close?.();

  const id = ctx.getImageData(0, 0, W, H);
  const g = toGray(id.data, W * H);
  const { b: raw, mean } = binarize(g, W, H, 51, 0.15);

  // Всё вне бумаги — фон (стол не должен попадать в распознавание).
  const inPaper = new Uint8Array(W * H).fill(1);
  if (paper) {
    for (let y = 0; y < H; y++) {
      const sy = Math.floor((box.y + y / s) * paper.k);
      const span = paper.spans[Math.min(paper.spans.length - 1, sy)];
      if (!span) { inPaper.fill(0, y * W, (y + 1) * W); continue; }
      const l = Math.max(0, Math.round((span[0] - box.x) * s) + 6);
      const r = Math.min(W, Math.round((span[1] - box.x) * s) - 6);
      inPaper.fill(0, y * W, y * W + Math.max(0, l));
      if (r < W) inPaper.fill(0, y * W + Math.max(0, r), (y + 1) * W);
    }
  }
  for (let i = 0; i < W * H; i++) if (!inPaper[i]) raw[i] = 0;

  let b = removeLines(raw, W, H, 120, 85, 7);
  b = removeSpecks(b, W, H, 14, 7);

  // Что удалили (линии, точки) — расширяем на 2 пикселя, чтобы не осталось серых ореолов.
  const erased = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!raw[i] || b[i]) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H && !b[ny * W + nx]) erased[ny * W + nx] = 1;
    }
  }

  const make = (pixel) => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const cx = c.getContext('2d');
    const out = cx.createImageData(W, H);
    const d = out.data;
    for (let i = 0; i < W * H; i++) {
      const v = pixel(i);
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
      d[i * 4 + 3] = 255;
    }
    cx.putImageData(out, 0, 0);
    return c;
  };

  // Серый: делим на локальную яркость фона — тени исчезают, буквы сохраняют полутона.
  const grayCanvas = make((i) => {
    if (!inPaper[i] || erased[i]) return 255;
    const v = (g[i] / Math.max(1, mean[i])) * 255;
    return v >= 235 ? 255 : Math.max(0, Math.min(255, (v - 60) * 1.4));
  });
  const binCanvas = make((i) => (b[i] ? 0 : 255));
  return { gray: grayCanvas, binary: binCanvas };
}

const STATUS_RU = {
  'loading tesseract core': 'Загрузка модуля распознавания…',
  'initializing tesseract': 'Запуск…',
  'initialized tesseract': 'Запуск…',
  'loading language traineddata': 'Загрузка языков (только в первый раз)…',
  'loaded language traineddata': 'Языки загружены',
  'initializing api': 'Подготовка…',
  'initialized api': 'Подготовка…',
  'recognizing text': 'Распознаю текст…',
};

// Распознаёт фото чека несколькими способами (разная обработка изображения и разметка страницы).
// done(texts) вызывается после каждой попытки; если вернул true — останавливаемся.
// Возвращает тексты всех выполненных попыток.
export async function recognize(file, langs, onProgress, done = () => false) {
  progressCb = (m) => onProgress?.({ status: STATUS_RU[m.status] || m.status, progress: m.progress || 0 });
  onProgress?.({ status: 'Обработка фото…', progress: 0 });
  const images = await preprocess(file);
  const w = await getWorker(langs || 'rus+ron+eng');

  const attempts = [
    ['gray', '6'], // серое изображение, единый блок — лучшие названия
    ['binary', '4'], // ч/б, колонка — лучше читает крупный итог
    ['binary', '6'],
    ['gray', '4'],
  ];
  const texts = [];
  for (let i = 0; i < attempts.length; i++) {
    const [img, psm] = attempts[i];
    if (i > 0) onProgress?.({ status: `Уточняю: попытка ${i + 1} из ${attempts.length}…`, progress: 0 });
    await w.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: '1' });
    const { data } = await w.recognize(images[img]);
    texts.push(data.text || '');
    if (done(texts)) break;
  }
  return texts;
}

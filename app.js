// =============================================================
// Мини-приложение "Решебник".
//
// Внутри MAX работает через MAX Bridge (window.WebApp, см. https://dev.max.ru/docs/webapps/bridge).
// Вне MAX — автономное превью UI в обычном браузере, чтобы верстку можно было смотреть локально.
// =============================================================

// Адрес бэкенда задаётся в config.js — там же инструкция для ngrok.
const BACKEND_URL = window.APP_CONFIG?.BACKEND_URL || "http://localhost:3000";

// ---------- MAX Bridge ----------
const max = {
  mode: "loading", // loading | max | preview | blocked
  initData: null,
  user: null,
};

/**
 * Похоже ли, что нас открыли внутри клиента MAX.
 * Признаки: параметры запуска в адресе (initData приходит фрагментом после #)
 * либо страница загружена во фрейме.
 */
function looksLikeMaxEnvironment() {
  const launchParams = /(^|[#&?])WebAppData=/.test(location.hash) || /(^|[#&?])WebAppData=/.test(location.search);
  let framed = false;
  try {
    framed = window.parent !== window;
  } catch {
    framed = true; // доступ к parent закрыт — значит точно чужой фрейм
  }
  return launchParams || framed;
}

/** Непустая строка запуска или null. Пробелы не считаются данными. */
function launchDataOf(bridge) {
  const raw = bridge?.initData;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * Ждём не появления window.WebApp, а появления строки запуска.
 *
 * Скрипт Bridge создаёт window.WebApp даже в обычном браузере вне MAX — проверено:
 * объект есть, а initData пустой. Значит наличие объекта ничего не доказывает,
 * признак настоящего MAX — подписанная строка запуска.
 */
function waitForLaunchData(timeoutMs = 3000, stepMs = 50) {
  return new Promise((resolve) => {
    const done = () => ({ bridge: window.WebApp ?? null, initData: launchDataOf(window.WebApp) });
    if (launchDataOf(window.WebApp)) return resolve(done());
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (launchDataOf(window.WebApp) || Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        resolve(done());
      }
    }, stepMs);
  });
}

function showSetupNotice(text, tone) {
  let el = document.getElementById("setup-notice");
  if (!el) {
    el = document.createElement("p");
    el.id = "setup-notice";
    el.style.cssText =
      "margin:12px 0 0;padding:10px 12px;border-radius:12px;font-size:13px;line-height:1.4;";
    document.querySelector(".setup")?.appendChild(el);
  }
  el.textContent = text;
  el.style.background = tone === "error" ? "rgba(220,38,38,.12)" : "rgba(120,120,120,.12)";
  el.style.color = tone === "error" ? "#b91c1c" : "inherit";
}

async function initMaxBridge() {
  const { bridge, initData } = await waitForLaunchData();

  if (initData) {
    max.mode = "max";
    // initData — подписанная строка запуска, её проверяет бэкенд. Доверять данным
    // из initDataUnsafe на клиенте нельзя, они только для отрисовки.
    max.initData = initData;
    max.user = bridge?.initDataUnsafe?.user ?? null;
  } else if (looksLikeMaxEnvironment()) {
    // Мы внутри MAX, но Bridge не поднялся — дальше setup не пускаем:
    // без initData бэкенд не сможет понять, кто пришёл.
    max.mode = "blocked";
    showSetupNotice(
      "Не удалось связаться с MAX. Закройте мини-приложение и откройте его заново.",
      "error"
    );
  } else {
    max.mode = "preview";
    showSetupNotice("Превью вне MAX: часть возможностей недоступна.", "info");
  }

  updateSetupCta();
}

document.addEventListener("DOMContentLoaded", initMaxBridge);

const GRADES = Array.from({ length: 11 }, (_, i) => i + 1);

// Версия фронта: видима на экране настройки и в консоли — так с телефона
// можно убедиться, что кэш не подсунул старый app.js.
console.log("Домашка в МАХ, фронт " + (window.APP_VERSION ?? "dev"));
document.getElementById("app-version").textContent = "версия " + (window.APP_VERSION ?? "dev");



const state = {
  mode: "solve",
  check: null, // последний результат проверки домашней работы // solve — решить задачу из учебника, check — проверить свою работу
  grade: null,
  subject: null,
  // Один снимок за раз: экран съёмки показывает его крупно, рамка выделения — прямо на нём.
  // Массив был нужен ради нескольких миниатюр; с одним кадром он только добавлял учёт id.
  photo: null, // { file, dataUrl, cropNorm, cropTouched }
  recognizedText: "",
  solution: null,
  // Аккордеон нескольких задач (02.09): исходный массив разметки vision и
  // клиентский кэш решений по индексу — повторный тап раскрывает из памяти,
  // без повторной генерации (решение Ильи).
  sheetTasks: null,
  taskState: new Map(), // index → { status: "streaming"|"done"|"error", solution }
  // Защита от «удара в стену» (03.09, инцидент 5 одинаковых сбоев): серия
  // solver-ошибок ПОДРЯД по одному и тому же условию (ключ — хэш текста).
  failStreak: null, // { key, count }
};

/** Хэш условия для failStreak (djb2) — только чтобы отличать «та же задача». */
function condKey(text) {
  let h = 5381;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h.toString(16);
}

/** Чистый шаг серии: тот же ключ — растим счётчик, новый — серия с единицы. */
function bumpFailStreak(streak, key) {
  return streak && streak.key === key ? { key, count: streak.count + 1 } : { key, count: 1 };
}

/**
 * Сообщение при сбое solver: со ВТОРОЙ одинаковой ошибки подряд по той же
 * задаче (решение Ильи: второй одинаковый удар — уже стена) вместо
 * технического текста — действенный совет; композер рядом.
 */
function solverFailMessage(conditionText, fallbackMsg) {
  state.failStreak = bumpFailStreak(state.failStreak, condKey(conditionText));
  if (state.failStreak.count >= 2) {
    return "Эта задача у нас пока не получается — попробуй сфотографировать иначе или опиши словами.";
  }
  return fallbackMsg;
}

// ---------- клавиатура на iOS (WebKit): честная высота через visualViewport ----------
// WebKit игнорирует interactive-widget (это Chromium-фича) и не сжимает
// svh под клавиатуру: она ложится ПОВЕРХ, а страницу WebKit панорамирует
// сам. visualViewport (iOS 13+, есть и в WKWebView) даёт реальную видимую
// высоту и событие resize при клавиатуре. Пишем её в --vvh; экран съёмки
// при фокусе поля использует var(--vvh) вместо svh (style.css), плюс
// возвращаем сфокусированное поле в видимую область — компенсация
// авто-панорамирования. В Chromium vv.height совпадает с layout-высотой,
// хук ничего не меняет.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const applyVvh = () => {
    document.documentElement.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
    const el = document.activeElement;
    if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
      // Задержка — WebKit доводит панорамирование после resize.
      setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 60);
    }
  };
  vv.addEventListener("resize", applyVvh);
  applyVvh();
}

// ---------- навигация между экранами ----------
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((el) => {
    el.dataset.active = el.id === id ? "true" : "false";
  });
}

// ---------- экран 1: setup ----------
function renderChips(container, items, onSelect) {
  container.innerHTML = "";
  items.forEach((item) => {
    const btn = document.createElement("button");
    btn.className = "chip";
    btn.textContent = item;
    btn.addEventListener("click", () => onSelect(item, btn));
    container.appendChild(btn);
  });
}

function selectChip(container, btn) {
  [...container.children].forEach((c) => (c.dataset.selected = "false"));
  btn.dataset.selected = "true";
}

const gradeRow = document.getElementById("grade-row");
const subjectRow = document.getElementById("subject-row");
const subjectBlock = document.getElementById("subject-block");
const btnModeSolve = document.getElementById("btn-mode-solve");
const btnModeCheck = document.getElementById("btn-mode-check");

renderChips(gradeRow, GRADES.map((g) => `${g} класс`), (label, btn) => {
  state.grade = GRADES[[...gradeRow.children].indexOf(btn)];
  selectChip(gradeRow, btn);
  loadSubjects(state.grade);
  updateSetupCta();
});

// ---------- предметы: список зависит от класса и приходит с бэкенда ----------

const SUBJECTS_TIMEOUT_MS = 15_000;
const subjectsCache = {}; // класс → список; в рамках сессии список не меняется

// Ответы могут приходить не в том порядке, в котором кликали классы:
// применяем только ответ на ПОСЛЕДНИЙ запрос.
let subjectsRequestId = 0;

async function getJson(path, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      headers: {
        // ngrok без этого заголовка отдаёт браузеру HTML-заглушку вместо API.
        "ngrok-skip-browser-warning": "true",
        ...(max.initData ? { "X-Max-Init-Data": max.initData } : {}),
        ...(window.APP_VERSION ? { "X-App-Version": window.APP_VERSION } : {}),
      },
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(humanizeError(res.status, { serverMessage: data?.error }));
      err.status = res.status;
      err.body = data;
      markNotSubscribed(err);
      throw err;
    }
    return data;
  } catch (err) {
    if (err.status) throw err;
    throw new Error(humanizeError(null, err));
  } finally {
    clearTimeout(timer);
  }
}

async function loadSubjects(grade) {
  subjectBlock.hidden = false;
  const requestId = ++subjectsRequestId;

  if (subjectsCache[grade]) {
    renderSubjectChips(subjectsCache[grade]);
    return;
  }

  renderSubjectSkeleton();
  try {
    const data = await getJson(`/api/subjects?grade=${grade}`, SUBJECTS_TIMEOUT_MS);
    if (requestId !== subjectsRequestId) return; // уже выбрали другой класс
    subjectsCache[grade] = data.subjects;
    renderSubjectChips(data.subjects);
  } catch (err) {
    if (requestId !== subjectsRequestId) return;
    if (err.notSubscribed) { showSubscribeScreen(); return; }
    renderSubjectError(err.message, grade);
  }
}

function renderSubjectChips(subjects) {
  renderChips(subjectRow, subjects, (label, btn) => {
    state.subject = label;
    selectChip(subjectRow, btn);
    updateSetupCta();
  });

  // Смена класса при выбранном предмете: если предмет есть и в новом списке —
  // сохраняем выбор; если нет (был 8 класс + Геометрия, стал 5) — сбрасываем,
  // иначе бэкенд ответит 400 на невозможную пару.
  if (state.subject) {
    const idx = subjects.indexOf(state.subject);
    if (idx !== -1) {
      selectChip(subjectRow, subjectRow.children[idx]);
    } else {
      state.subject = null;
    }
  }
  updateSetupCta();
}

function renderSubjectSkeleton() {
  // Место под чипы, чтобы экран не мигал пустотой на время запроса.
  subjectRow.innerHTML = "";
  for (const width of [96, 120, 84, 108, 90] ) {
    const stub = document.createElement("span");
    stub.className = "chip chip-skeleton";
    stub.style.width = `${width}px`;
    subjectRow.appendChild(stub);
  }
}

function renderSubjectError(message, grade) {
  subjectRow.innerHTML = "";
  const box = document.createElement("div");
  box.className = "subject-error";
  const text = document.createElement("span");
  text.textContent = message;
  const retry = document.createElement("button");
  retry.className = "chip";
  retry.textContent = "Повторить";
  retry.addEventListener("click", () => loadSubjects(grade));
  box.append(text, retry);
  subjectRow.appendChild(box);
}

function updateSetupCta() {
  const bridgeBlocked = max.mode === "blocked" || max.mode === "loading";
  const blocked = !(state.grade && state.subject) || bridgeBlocked;
  btnModeSolve.disabled = blocked;
  btnModeCheck.disabled = blocked;
}

/** Режим задаёт и подсказку в кадре, и подпись кнопки: снимают разное. */
function applyMode(mode) {
  state.mode = mode;
  const check = mode === "check";
  document.querySelector(".capture-hint").textContent = check
    ? "Сфотографируй своё решение или выбери из галереи"
    : "Сфотографируй задачу или выбери из галереи";
  document.querySelector(".capture-sub").textContent = check
    ? "Один снимок — одна работа"
    : "Один снимок — одно задание";
  btnSolve.textContent = check ? "Проверить" : "Решить";
  btnSolve.dataset.idleLabel = btnSolve.textContent;
  updateCaptureTextVisibility(); // поле «опиши словами» — только в режиме решения
}

function enterCapture(mode) {
  applyMode(mode);
  showScreen("screen-capture");
}

btnModeSolve.addEventListener("click", () => enterCapture("solve"));
btnModeCheck.addEventListener("click", () => enterCapture("check"));
// Возврат к выбору класса — это начало новой сессии, снимки прошлой задачи не нужны.
document.getElementById("btn-back-setup").addEventListener("click", () => {
  startNewTask();
  showScreen("screen-setup");
});

// ---------- экран 2: capture ----------
const fileInput = document.getElementById("file-input");
const btnSolve = document.getElementById("btn-solve");
const captureEmpty = document.getElementById("capture-empty");
const capturePhoto = document.getElementById("capture-photo");
const cropTip = document.getElementById("crop-tip");
const cropFrame = document.getElementById("crop-frame");
const cropImage = document.getElementById("crop-image");
const cropBox = document.getElementById("crop-box");

const MIN_CROP_PX = 40; // меньше пальцем всё равно не выделить

let cropRect = null;  // {x, y, w, h} в пикселях ОТОБРАЖАЕМОГО изображения
let cropDrag = null;

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  // Сбрасываем сразу: иначе повторный выбор того же файла не вызовет change.
  e.target.value = "";
  if (!file) return;

  hideCaptureError();
  try {
    const dataUrl = await fileToDataUrl(file);
    state.photo = { file, dataUrl, cropNorm: null, cropTouched: false };
    showPhoto();
  } catch (err) {
    showCaptureError(err.message);
  }
});

/** Показывает снимок крупно и ставит рамку выделения поверх него. */
// Признак прокручиваемости окна превью (№1, 02.09): overlay-скроллбары в
// мобильных вебвью невидимы, ученик не понимал, что фото листается. Градиентные
// кромки (CSS) включаются классами, пока сверху/снизу есть скрытая часть фото.
const photoViewport = document.getElementById("photo-viewport");
function updatePhotoScrollHints() {
  const canDown = photoViewport.scrollTop + photoViewport.clientHeight < photoViewport.scrollHeight - 2;
  const canUp = photoViewport.scrollTop > 2;
  capturePhoto.classList.toggle("scroll-down", canDown);
  capturePhoto.classList.toggle("scroll-up", canUp);
}
photoViewport.addEventListener("scroll", updatePhotoScrollHints);

/** Дефолтная рамка: ~80% ВИДИМОЙ части окна превью — все четыре ручки в
 * кадре сразу (раньше 80% всего фото уводили нижние ручки за окно на
 * длинных снимках). Координаты — пиксели отображаемого изображения.
 * Короткое фото: visH = h, формула вырождается в прежние 80% изображения. */
function defaultCropRect(w, h, viewportH) {
  const visH = Math.min(viewportH, h);
  return { x: w * 0.1, y: visH * 0.1, w: w * 0.8, h: visH * 0.8 };
}

function showPhoto() {
  captureEmpty.hidden = true;
  capturePhoto.hidden = false;
  cropTip.hidden = false;
  updateCaptureTextVisibility(); // снимок есть — текстовое поле прячется

  cropImage.onload = () => {
    const w = cropImage.clientWidth;
    const h = cropImage.clientHeight;
    const n = state.photo?.cropNorm;
    // Рамку храним в долях, а не в пикселях: размер картинки на экране
    // зависит от устройства и ориентации.
    // Новый снимок показывается СНАЧАЛА (решение Ильи 03.09): scrollTop
    // переживал смену фото, и рамка вставала бы по случайному месту.
    // Сброс — ДО расчёта рамки.
    photoViewport.scrollTop = 0;
    cropRect = n
      ? { x: n.x * w, y: n.y * h, w: n.w * w, h: n.h * h }
      : defaultCropRect(w, h, photoViewport.clientHeight);
    drawCropBox();
    // Кромки-градиенты — после раскладки: scrollHeight известен только теперь.
    requestAnimationFrame(updatePhotoScrollHints);
  };
  cropImage.src = state.photo.dataUrl;
}

/** Возврат к состоянию «до съёмки». */
function resetPhoto() {
  state.photo = null;
  cropRect = null;
  cropDrag = null;
  lockScroll(false);
  cropImage.removeAttribute("src");
  capturePhoto.hidden = true;
  capturePhoto.classList.remove("scroll-down", "scroll-up");
  cropTip.hidden = true;
  captureEmpty.hidden = false;
  updateCaptureTextVisibility(); // снимка нет — поле возвращается (в режиме решения)
  hideCaptureError();
  hideModePrompt();
}

document.getElementById("btn-remove-photo").addEventListener("click", resetPhoto);

/**
 * Старт новой задачи. Вызывается только там, где ученик явно начинает следующую:
 * кнопки «Новая задача» / «Новая проверка» и возврат на выбор класса. При обычной
 * навигации назад внутри одной задачи ничего не сбрасывается.
 */
function startNewTask() {
  solveStream = null;
  resetPhoto();
  state.recognizedText = "";
  state.solution = null;
  state.check = null;
  state.sheetTasks = null;
  state.taskState = new Map();
  state.failStreak = null;
  recognizedTextEl.value = "";
  taskTextInput.value = "";
  multiTaskHint.hidden = true;
  composerPh.hidden = false;
  btnComposerSend.disabled = true;
  renderRecognizedView();
  updateConfirmCta();
}

function drawCropBox() {
  if (!cropRect) return;
  cropBox.style.left = `${cropRect.x}px`;
  cropBox.style.top = `${cropRect.y}px`;
  cropBox.style.width = `${cropRect.w}px`;
  cropBox.style.height = `${cropRect.h}px`;
}

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

/** На время перетаскивания замораживаем страницу: иначе жест уезжает в прокрутку. */
function lockScroll(on) {
  document.body.classList.toggle("crop-dragging", on);
}

cropFrame.addEventListener(
  "pointerdown",
  (e) => {
    if (!cropRect) return;
    const handle = e.target.closest(".crop-handle")?.dataset.handle;
    const insideBox = e.target === cropBox || e.target.closest(".crop-box");
    if (!handle && !insideBox) return;

    cropDrag = { handle: handle ?? null, startX: e.clientX, startY: e.clientY, start: { ...cropRect } };
    // Захват указателя: палец не теряет рамку, даже если ушёл за её край.
    cropFrame.setPointerCapture(e.pointerId);
    lockScroll(true);
    e.preventDefault();
  },
  { passive: false }
);

// passive: false обязателен — иначе preventDefault в обработчике игнорируется.
cropFrame.addEventListener(
  "pointermove",
  (e) => {
    if (!cropDrag || !cropRect) return;
    const w = cropImage.clientWidth;
    const h = cropImage.clientHeight;
    const dx = e.clientX - cropDrag.startX;
    const dy = e.clientY - cropDrag.startY;
    const s = cropDrag.start;

    if (!cropDrag.handle) {
      cropRect.x = clamp(s.x + dx, 0, w - s.w);
      cropRect.y = clamp(s.y + dy, 0, h - s.h);
    } else {
      let { x, y } = s;
      let right = s.x + s.w;
      let bottom = s.y + s.h;
      if (cropDrag.handle.includes("w")) x = clamp(s.x + dx, 0, right - MIN_CROP_PX);
      if (cropDrag.handle.includes("e")) right = clamp(right + dx, x + MIN_CROP_PX, w);
      if (cropDrag.handle.includes("n")) y = clamp(s.y + dy, 0, bottom - MIN_CROP_PX);
      if (cropDrag.handle.includes("s")) bottom = clamp(bottom + dy, y + MIN_CROP_PX, h);
      cropRect = { x, y, w: right - x, h: bottom - y };
    }

    // Рамку тронули — значит выделение осознанное, отправлять будем только его.
    if (state.photo) {
      state.photo.cropTouched = true;
      state.photo.cropNorm = { x: cropRect.x / w, y: cropRect.y / h, w: cropRect.w / w, h: cropRect.h / h };
    }
    drawCropBox();
    e.preventDefault();
  },
  { passive: false }
);

const endCropDrag = () => {
  cropDrag = null;
  lockScroll(false);
};
cropFrame.addEventListener("pointerup", endCropDrag);
cropFrame.addEventListener("pointercancel", endCropDrag);
// Страховка: если захват указателя потерян, страница не должна остаться замороженной.
cropFrame.addEventListener("lostpointercapture", endCropDrag);

/**
 * Что уходит на бэкенд: обрезка, если рамку двигали, иначе весь кадр.
 * Оригинал не перезаписывается — выделение можно переделать.
 */
function imageForUpload() {
  const photo = state.photo;
  if (!photo) return null;
  if (!photo.cropTouched || !cropRect) return photo.dataUrl;

  const scaleX = cropImage.naturalWidth / cropImage.clientWidth;
  const scaleY = cropImage.naturalHeight / cropImage.clientHeight;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(cropRect.w * scaleX));
  canvas.height = Math.max(1, Math.round(cropRect.h * scaleY));
  canvas
    .getContext("2d")
    .drawImage(
      cropImage,
      cropRect.x * scaleX, cropRect.y * scaleY,
      cropRect.w * scaleX, cropRect.h * scaleY,
      0, 0, canvas.width, canvas.height
    );

  // JPEG: кроп фотографии в PNG весил бы кратно больше и упирался бы в лимит запроса.
  return canvas.toDataURL("image/jpeg", 0.92);
}

const FILE_READ_ERROR = "Не удалось прочитать фото, попробуйте другой снимок.";

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    // Без этого при сбое чтения промис не резолвился никогда и await висел молча.
    reader.onerror = () => reject(new Error(FILE_READ_ERROR));
    reader.onabort = () => reject(new Error(FILE_READ_ERROR));
    try {
      reader.readAsDataURL(file);
    } catch {
      reject(new Error(FILE_READ_ERROR));
    }
  });
}

// Кнопка на экране подтверждения — назад к съёмке.
document.getElementById("btn-back-capture").addEventListener("click", () => showScreen("screen-capture"));

const recognizedTextEl = document.getElementById("recognized-text");

/** Минимальная индикация занятости кнопки: запрос с фото идёт 20–30 секунд. */
function setButtonBusy(btn, busy, busyLabel) {
  if (busy) {
    btn.dataset.idleLabel = btn.dataset.idleLabel ?? btn.textContent;
    btn.textContent = busyLabel;
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.idleLabel ?? btn.textContent;
    btn.disabled = false;
  }
}

/** Сообщение об ошибке прямо на экране съёмки — чтобы можно было переснять, не уходя дальше. */
function showCaptureError(text) {
  let el = document.getElementById("capture-error");
  if (!el) {
    el = document.createElement("p");
    el.id = "capture-error";
    el.style.cssText =
      "margin:12px 0 0;padding:10px 12px;border-radius:12px;font-size:13px;line-height:1.4;" +
      "background:rgba(220,38,38,.12);color:#b91c1c;";
    document.querySelector(".capture-actions")?.insertAdjacentElement("beforebegin", el);
  }
  el.textContent = text;
  el.hidden = false;
}

function hideCaptureError() {
  const el = document.getElementById("capture-error");
  if (el) el.hidden = true;
}

// ---------- композер «условие словами» (запасной путь к фото, только «решить») ----------
const captureTextBlock = document.getElementById("capture-text-block");
const taskTextInput = document.getElementById("task-text-input");
const multiTaskHint = document.getElementById("multi-task-hint");
const captureActions = document.getElementById("capture-actions");
const composerPh = document.getElementById("composer-ph");
const btnComposerSend = document.getElementById("btn-composer-send");

/** Композер виден до съёмки и только в режиме решения; отправка — его кнопкой,
 * большая «Решить» в этом состоянии прячется (03.09: две кнопки путали бы).
 * Проверка домашки требует снимок тетради — там всегда прежняя CTA. */
function updateCaptureTextVisibility() {
  const composer = state.mode !== "check" && !state.photo;
  captureTextBlock.hidden = !composer;
  captureActions.hidden = composer;
}

/** Отправка типизированного условия — общая для композера и страховочной
 * ветки btnSolve: мимо confirm сразу в стрим. false — поле пустое. */
function submitTypedTask() {
  const typed = taskTextInput.value.trim();
  if (!typed) return false;
  state.solution = null;
  state.recognizedText = typed;
  recognizedTextEl.value = typed; // confirm-поле в курсе: возврат с решения покажет актуальный текст
  const st = startSolveStream(
    // textSource: 'typed' — свежий ввод, НЕ правка распознанного (textEdited
    // не шлём: метрика «доля правок» не должна портиться ручным вводом).
    { text: typed, grade: state.grade, subject: state.subject, textSource: "typed" },
    { allowEarlyConfirm: false, allowPrompt: false }
  );
  renderSolutionStreaming(st);
  showScreen("screen-solution");
  st.promise.catch(() => {}); // сбой уже показан плашкой живого рендера
  return true;
}

btnComposerSend.addEventListener("click", () => { submitTypedTask(); });

// ---------- голосовой ввод (03.09): MediaRecorder → /api/transcribe → поле ----------
// Путь выбран зондом: SpeechRecognition в вебвью MAX мёртв (service-not-allowed),
// запись работает (audio/mp4). Расшифровка — whisper.cpp на бэке. Текст падает
// В ПОЛЕ композера (не авто-решение): ученик видит, правит, отправляет сам.
// Кнопка появляется ТОЛЬКО при живом API (фича-детект) — в средах без записи
// её нет, дырки в вёрстке тоже (flex-слот).
const btnMic = document.getElementById("btn-composer-mic");
let voiceRec = null; // активная запись: { rec, stream, timer }

const VOICE_OK = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
if (VOICE_OK) {
  btnMic.hidden = false;
  composerPh.textContent = "Опиши задачу словами или голосом";
  btnMic.addEventListener("click", toggleVoice);
}

async function toggleVoice() {
  if (voiceRec) { voiceRec.rec.stop(); return; } // второй тап — стоп
  hideCaptureError();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showCaptureError("Нет доступа к микрофону — разреши его в настройках или напиши текстом.");
    return;
  }
  const mime = ["audio/mp4", "audio/webm"].find((m) => MediaRecorder.isTypeSupported?.(m));
  const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  rec.onstop = async () => {
    clearTimeout(voiceRec?.timer);
    voiceRec = null;
    stream.getTracks().forEach((t) => t.stop());
    btnMic.classList.remove("recording");
    const blob = new Blob(chunks, { type: rec.mimeType || mime || "audio/mp4" });
    if (blob.size < 1500) return; // случайный тап: полсекунды тишины не шлём
    btnMic.disabled = true;
    btnMic.classList.add("busy");
    try {
      const dataUrl = await fileToDataUrl(blob);
      const res = await postJson("/api/transcribe", { audioBase64: dataUrl }, 30000);
      if (res.text) {
        taskTextInput.value = taskTextInput.value.trim()
          ? taskTextInput.value.trim() + " " + res.text
          : res.text;
        // Один вход для подсказки/плейсхолдера/кнопки — как при ручном вводе.
        taskTextInput.dispatchEvent(new Event("input"));
      }
    } catch (err) {
      showCaptureError(err.message);
    } finally {
      btnMic.disabled = false;
      btnMic.classList.remove("busy");
    }
  };
  rec.start();
  // Потолок записи 60 с: школьная задача короче, а бэкенд-лимит — 10 МБ.
  voiceRec = { rec, stream, timer: setTimeout(() => rec.stop(), 60_000) };
  btnMic.classList.add("recording");
}

/**
 * Признаки НЕСКОЛЬКИХ заданий в тексте: ≥2 буквенных пунктов («а) … б) …»)
 * или ≥2 строк, начинающихся с номера («1) …», «№2 …»). Только мягкая
 * подсказка под полем — отправку НЕ блокирует (решение Ильи 02.09: текст =
 * одна задача, разметку не тянем). Родственник MULTI_TASK_MARKS в
 * routes/checkHomework.js — независимый канал с той же природой меток.
 */
function detectMultiTaskText(text) {
  const letterMarks = (text.match(/(?:^|[\s.,;])[абвгдежз]\)/gi) ?? []).length;
  const numberedLines = text.split("\n").filter((l) => /^\s*(№\s*\d+|\d+\))/.test(l)).length;
  return letterMarks >= 2 || numberedLines >= 2;
}

taskTextInput.addEventListener("input", () => {
  multiTaskHint.hidden = !detectMultiTaskText(taskTextInput.value);
  // Оверлей-плейсхолдер и кнопка отправки живут от того же события.
  composerPh.hidden = taskTextInput.value.length > 0;
  btnComposerSend.disabled = taskTextInput.value.trim().length === 0;
});

btnSolve.addEventListener("click", async () => {
  hideCaptureError();
  hideModePrompt();

  // Фото нет: в режиме решения эта кнопка скрыта (отправляет композер), ветка —
  // страховка; в режиме проверки без фото — честная ошибка (текстом тетрадь
  // не опишешь). Типизированный путь целиком в submitTypedTask (мимо confirm).
  if (!state.photo) {
    if (state.mode === "check" || !submitTypedTask()) {
      showCaptureError(state.mode === "check"
        ? "Сфотографируй страницу тетради с решением — проверяю по фото."
        : "Сфотографируй задачу или опиши её словами.");
    }
    return;
  }

  // dataUrl уже в виде data:image/...;base64,... — vision.js принимает такой формат.
  // Если рамку двигали, уйдёт только выделенное. Эндпоинты ждут массив — оборачиваем.
  const payload = {
    imagesBase64: [imageForUpload()],
    grade: state.grade,
    subject: state.subject,
  };
  await runRecognition(state.mode, payload);
});

// ---------- потоковый solve: шаги приходят по мере генерации ----------
// Поток НЕ обязателен: при любой ошибке (сеть, прокси, кривая строка) слой
// сам откатывается на обычный postJson — ученик видит то же самое, только
// без досрочных шагов. Этапные надписи остаются фолбэком и работают до
// первого события. Контракт финального события = ответ /api/solve.

let solveStream = null; // активный поток; сверяем ссылку, чтобы старый не рисовал

async function readNdjson(path, payload, timeoutMs, onEvent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
        ...(max.initData ? { "X-Max-Init-Data": max.initData } : {}),
        ...(window.APP_VERSION ? { "X-App-Version": window.APP_VERSION } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error("поток недоступен: " + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) onEvent(JSON.parse(line));
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Запускает потоковое решение. Возвращает объект потока:
 *   steps — уже пришедшие шаги; final — {code, body} финала (или null);
 *   error — ошибка, когда И поток, И фолбэк-POST не удались;
 *   earlyShown — экран подтверждения уже показан этим слоем;
 *   onStep/onDone — подписки живого рендера; promise — завершение всего.
 */
function startSolveStream(payload, { allowEarlyConfirm, allowPrompt }) {
  const st = { steps: [], final: null, error: null, earlyShown: false, onStep: null, onDone: null };
  solveStream = st;
  const finish = (fin) => {
    if (st.final) return;
    st.final = fin;
    if (solveStream === st) st.onDone?.(fin);
  };
  st.promise = readNdjson("/api/solve/stream", payload, SOLVE_TIMEOUT_MS, (e) => {
    if (solveStream !== st) return; // ученик уже начал другую задачу
    if (e.type === "recognized" && allowEarlyConfirm && e.recognizedText) {
      const suggested = allowPrompt ? suggestedMode("solve", e.recognition?.contentType) : null;
      if (!suggested) {
        // Подтверждение — сразу после vision: решение дописывается фоном,
        // и «Верно, решай» покажет шаги, не дожидаясь конца генерации.
        state.solution = null;
        state.recognizedText = e.recognizedText;
        recognizedTextEl.value = e.recognizedText;
        setRecognizedEditing(false);
        stopStages();
        setButtonBusy(btnSolve, false);
        showScreen("screen-confirm");
        st.earlyShown = true;
      }
    } else if (e.type === "step") {
      st.steps.push(e.step);
      st.onStep?.(e.step, e.index);
    } else if (e.type === "final" || e.type === "error") {
      finish({ code: e.code, body: e.body });
    }
  })
    .then(() => {
      if (!st.final) throw new Error("поток оборвался без финала");
    })
    .catch(async () => {
      if (st.final) return;
      // ФОЛБЭК: любой сбой потока → обычный POST тем же payload.
      try {
        const body = await postJson("/api/solve", { ...payload, streamFallback: true }, SOLVE_TIMEOUT_MS);
        finish({ code: 200, body });
      } catch (postErr) {
        st.error = postErr;
        if (solveStream === st) st.onDone?.(null);
        throw postErr;
      }
    });
  return st;
}

// ---------- очередь пословной печати ----------
// Темп: ~24 мс/слово — шаг из 2–3 предложений (~40 слов) допечатывается
// за ~1 секунду. Если в очереди ждёт следующий шаг — текущий проявляется
// мгновенно (ускорение, не обрыв): анимация никогда не задерживает контент
// дольше одной печати. Фолбэк и кэш-хит идут мимо очереди (renderSolution).
const TYPE_WORD_MS = 24;
const typeQueue = [];
let typeDraining = false;
let typeQueueEmptyResolvers = [];

function computeTypeDelay(queueLen) {
  return queueLen > 0 ? 0 : TYPE_WORD_MS;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function enqueueTyping(li) {
  typeQueue.push(li);
  if (!typeDraining) drainTypeQueue();
}

async function drainTypeQueue() {
  typeDraining = true;
  while (typeQueue.length) {
    const li = typeQueue.shift();
    for (const w of li.querySelectorAll(".tw")) {
      w.style.visibility = "";
      const delay = computeTypeDelay(typeQueue.length);
      if (delay) await sleep(delay);
    }
  }
  typeDraining = false;
  for (const r of typeQueueEmptyResolvers) r();
  typeQueueEmptyResolvers = [];
}

function waitTypeQueue() {
  if (!typeDraining && !typeQueue.length) return Promise.resolve();
  return new Promise((r) => typeQueueEmptyResolvers.push(r));
}

/** Мгновенно допечатывает всё, что ждёт в очереди (аккордеон: старт новой
 * задачи не должен бросать чужие слова скрытыми — прежнее обнуление
 * typeQueue.length=0 именно это и делало). Начатый li дорисует своим темпом. */
function flushTypeQueue() {
  for (const li of typeQueue) {
    for (const w of li.querySelectorAll(".tw")) w.style.visibility = "";
  }
  typeQueue.length = 0;
}

/** Живой рендер экрана решения: буфер шагов + дорисовка + финал одним блоком. */
function renderSolutionStreaming(st) {
  solutionTask.textContent = state.recognizedText || "";
  // Буфер уже пришедших шагов печатается той же очередью (с ускорением),
  // вся вёрстка и KaTeX готовы заранее — проявляются только слова.
  typeQueue.length = 0;
  stepsList.innerHTML = st.steps.map((step, i) => stepMarkup(step, i, true)).join("");
  renderMath(stepsList);
  for (const li of stepsList.children) enqueueTyping(li);
  renderGraphCard(null);
  renderFigureCard(null);
  renderSchemaCard(null);
  // Резерв под ответ и бейдж: плашка стоит на месте будущего блока ответа,
  // финал заменяет её целиком — прочитанные шаги выше не сдвигаются.
  answerBlock.innerHTML = `<p class="answer-pending answer-pending--busy">${pendingBusyMarkup("Дорешиваем и проверяем ответ вычислением")}</p>`;
  resetFeedback(solutionScreen);
  solutionScreen.querySelector(".sheet-scroll").scrollTop = 0;
  st.onStep = (step) => {
    stepsList.insertAdjacentHTML("beforeend", stepMarkup(step, stepsList.children.length, true));
    renderMath(stepsList.lastElementChild);
    enqueueTyping(stepsList.lastElementChild);
  };
  st.onDone = async (fin) => {
    st.onStep = null;
    st.onDone = null;
    await waitTypeQueue(); // допечатать начатое; ускорение делает это <1 с
    if (fin && fin.code === 200 && !fin.body.multipleTasks) {
      state.failStreak = null; // успех рвёт серию
      state.solution = fin.body;
      completeStreamedSolution(fin.body);
    } else {
      let msg = fin
        ? humanizeError(fin.code, { serverMessage: fin.body?.error })
        : (st.error?.message ?? "Что-то пошло не так на нашей стороне. Попробуй позже.");
      // Серия — только по техническим сбоям (5xx/двойной обрыв): у 4xx-отказов
      // совет уже в самом тексте.
      if (!fin || fin.code >= 500) msg = solverFailMessage(state.recognizedText, msg);
      answerBlock.innerHTML = `<p class="answer-pending">${escapeHtml(msg)}</p>`;
    }
  };
  if (st.final || st.error) st.onDone(st.final); // финал успел раньше подписки
}

/** Финал стрима: шаги не перерисовываем (прочитанное не дёргается), доезжает остальное. */
function completeStreamedSolution(result) {
  if (stepsList.children.length !== (result.steps?.length ?? 0)) {
    // Разошлись (например, финал пришёл фолбэк-POST'ом без стрим-шагов) — дорисовываем целиком.
    stepsList.innerHTML = stepsMarkup(result.steps);
    renderMath(stepsList);
  }
  renderGraphCard(result.graph);
  renderFigureCard(result.figure);
  renderSchemaCard(result.schemaId);
  answerBlock.innerHTML = answerMarkup(result);
  renderMath(answerBlock);
}

/**
 * Отправляет снимок в выбранном режиме и решает, что показать.
 *
 * @param {"solve"|"check"} mode
 * @param {object} payload - тот же самый, что и при первой отправке: переспрос
 *   не должен приводить к повторному распознаванию с нуля
 * @param {boolean} [allowPrompt=true] - после переключения режима не переспрашиваем снова
 */
async function runRecognition(mode, payload, allowPrompt = true) {
  const check = mode === "check";
  setButtonBusy(btnSolve, true, check ? "Читаем твою работу…" : "Читаем условие с фото…");
  startStages(btnSolve, check ? CHECK_STAGES : SOLVE_STAGES);
  try {
    let result;
    if (check) {
      // Проверка последовательно поднимает три модели, отсюда увеличенный таймаут.
      // Стриминг check не ускоряет: до третьего вызова стримить нечего.
      result = await postJson("/api/check-homework", payload, CHECK_TIMEOUT_MS);
    } else {
      const st = startSolveStream(payload, { allowEarlyConfirm: Boolean(payload.imagesBase64?.length), allowPrompt });
      await st.promise; // фолбэк на POST уже внутри; сюда долетают только двойные сбои
      if (st.earlyShown) return; // экран подтверждения показан, поток дописывается фоном
      if (st.final.code !== 200) {
        const err = new Error(humanizeError(st.final.code, { serverMessage: st.final.body?.error }));
        err.status = st.final.code;
        err.body = st.final.body;
        markNotSubscribed(err);
        throw err;
      }
      result = st.final.body;
    }

    const suggested = allowPrompt ? suggestedMode(mode, result.recognition?.contentType) : null;
    if (suggested) {
      pendingResult = { mode, payload, result, suggested };
      showModePrompt(suggested);
      return;
    }
    showResult(mode, result);
  } catch (err) {
    if (err.notSubscribed) { showSubscribeScreen(); return; }
    // 422 — «не разобрали фото» или «печатного условия не найдено»: остаёмся на съёмке.
    showCaptureError(err.message);
  } finally {
    stopCheckStages();
    setButtonBusy(btnSolve, false);
  }
}

function showResult(mode, result) {
  if (mode === "check") {
    // На листе несколько задач — выбор, как в solve-пути; проверять будем фрагмент.
    const checkTasks = result.multipleTasks ? result.recognition?.tasks : null;
    if (Array.isArray(checkTasks) && checkTasks.length > 1) {
      renderCheckTaskList(checkTasks);
      showScreen("screen-tasks");
      return;
    }
    state.check = result;
    renderCheck(result);
    showScreen("screen-check");
    return;
  }

  // На фото несколько заданий — сначала спрашиваем, какое решать.
  const tasks = result.recognition?.tasks;
  if (Array.isArray(tasks) && tasks.length > 1) {
    renderTaskList(tasks);
    showScreen("screen-tasks");
    return;
  }

  // Кладём ответ целиком: recognizedText, steps, finalAnswer, verification и всё остальное.
  state.solution = result;
  state.recognizedText = result.recognizedText ?? "";
  recognizedTextEl.value = state.recognizedText;
  setRecognizedEditing(false);
  showScreen("screen-confirm");
}

// ---------- переспрос о режиме ----------
// Модель сообщает, что реально на снимке (recognition.contentType). Переспрашиваем
// ТОЛЬКО при явном противоречии: unclear и совпадение — молчим. Смешанные фото
// (условие и решение сразу) дают unclear и встречаются чаще всего, дёргать на них нельзя.
const modePrompt = document.getElementById("mode-prompt");
const modePromptText = document.getElementById("mode-prompt-text");

let pendingResult = null;

function suggestedMode(mode, contentType) {
  if (mode === "solve" && contentType === "handwritten_work") return "check";
  // Рукописное УСЛОВИЕ (доска, карточка) в режиме проверки — предлагать решение:
  // проверять там нечего, работы ученика на фото нет.
  if (mode === "check" && (contentType === "printed_task" || contentType === "handwritten_task")) return "solve";
  return null;
}

function showModePrompt(suggested) {
  modePromptText.textContent =
    suggested === "check"
      ? "Похоже, это уже решённая работа. Проверить её вместо решения?"
      : "Похоже, это чистая задача без решения. Решить её вместо проверки?";
  modePrompt.hidden = false;
}

function hideModePrompt() {
  modePrompt.hidden = true;
  pendingResult = null;
}

document.getElementById("mode-prompt-yes").addEventListener("click", async () => {
  const p = pendingResult;
  modePrompt.hidden = true;
  pendingResult = null;
  if (!p) return;

  // Переснимать не заставляем: тот же payload уходит на другой эндпоинт.
  applyMode(p.suggested);
  await runRecognition(p.suggested, p.payload, false);
});

document.getElementById("mode-prompt-no").addEventListener("click", () => {
  const p = pendingResult;
  modePrompt.hidden = true;
  pendingResult = null;
  // Настоял на своём — показываем то, что уже посчитали в исходном режиме.
  if (p) showResult(p.mode, p.result);
});

// ---------- экран 2.5: выбор задачи ----------
// Показывается, только если vision разметил на фото больше одного задания.
// Для одиночной задачи поток остался прежним.
const taskList = document.getElementById("task-list");

/** Карточка задания. index — позиция в исходном массиве, order — номер по порядку в группе. */
function taskCardMarkup(task, index, order) {
  const label = task.number ? `Задание ${escapeHtml(task.number)}` : `Задача ${order}`;
  const text = task.text
    .split("\n")
    .map((line) => `<p class="task-card-line">${escapeHtml(line)}</p>`)
    .join("");
  // Шапка кликабельна (тап = решить/раскрыть), task-acc — контейнер аккордеона:
  // решение раскрывается ВНУТРИ карточки, остальные задачи уходят под него.
  return `
    <li class="task-card" data-index="${index}">
      <div class="task-card-head">
        <p class="task-card-num">${label}</p>
        <div class="task-card-text">${text}</div>
      </div>
      <div class="task-acc" hidden></div>
    </li>`;
}

/** Экран выбора для ПРОВЕРКИ: карточка — условие (если ученик его переписал),
 *  иначе фрагмент работы; задачи без финального ответа — приглушённые, но
 *  кликабельные, с пометкой «без ответа» (описывает лист, а не ребёнка). */
function renderCheckTaskList(tasks) {
  document.querySelector("#screen-tasks .tasks-title").textContent = "Нашли несколько задач в тетради";
  document.querySelector("#screen-tasks .tasks-lead").textContent = "Выбери, какую проверить.";
  taskList.innerHTML = `<ol class="task-cards">${tasks
    .map((task, i) => {
      const source = (task.condition ?? "").trim() || task.work;
      const snippet = source.length > 180 ? source.slice(0, 180) + "…" : source;
      const label = task.number ? escapeHtml(task.number) : String(i + 1);
      const badge = task.hasAnswer ? "" : `<span class="task-badge">без ответа</span>`;
      return `
      <li>
        <button class="task-card${task.hasAnswer ? "" : " task-card--muted"}" data-check-index="${i}">
          <span class="task-num">${label}</span>
          <span class="task-text">${escapeHtml(snippet)}</span>
          ${badge}
        </button>
      </li>`;
    })
    .join("")}</ol>`;
  renderMath(taskList);
  for (const btn of taskList.querySelectorAll("[data-check-index]")) {
    btn.addEventListener("click", () => checkFragment(tasks[Number(btn.dataset.checkIndex)]));
  }
}

/** Второй запрос: проверка фрагмента выбранной задачи. Vision не повторяется. */
async function checkFragment(task) {
  setButtonBusy(btnSolve, true, "Читаем твою работу…");
  startCheckStages(btnSolve);
  showScreen("screen-capture");
  try {
    const result = await postJson("/api/check-homework", {
      workText: task.work,
      condition: (task.condition ?? "").trim() || undefined,
      grade: state.grade,
      subject: state.subject,
    }, CHECK_TIMEOUT_MS);
    state.check = result;
    renderCheck(result);
    showScreen("screen-check");
  } catch (err) {
    showCaptureError(err.message);
  } finally {
    stopCheckStages();
    setButtonBusy(btnSolve, false);
  }
}

function renderTaskList(tasks) {
  document.querySelector("#screen-tasks .tasks-title").textContent = "Нашли несколько задач";
  document.querySelector("#screen-tasks .tasks-lead").textContent = "Выбери, какую решить.";
  // Варианты размечены — группируем: в контрольной номера 1–7 повторяются в каждом
  // варианте, и без разделителей список превращается в кашу.
  const grouped = tasks.some((t) => t.variant);

  if (!grouped) {
    taskList.innerHTML = `<ol class="task-cards">${tasks
      .map((task, i) => taskCardMarkup(task, i, i + 1))
      .join("")}</ol>`;
  } else {
    const order = [];
    const byVariant = new Map();
    tasks.forEach((task, i) => {
      const key = task.variant ?? "";
      if (!byVariant.has(key)) {
        byVariant.set(key, []);
        order.push(key);
      }
      byVariant.get(key).push({ task, index: i });
    });

    taskList.innerHTML = order
      .map((key) => {
        const items = byVariant
          .get(key)
          .map(({ task, index }, n) => taskCardMarkup(task, index, n + 1))
          .join("");
        // Пустой ключ — задания без метки варианта, заголовок им не нужен.
        const title = key ? `<p class="task-group">Вариант ${escapeHtml(key)}</p>` : "";
        return `${title}<ol class="task-cards">${items}</ol>`;
      })
      .join("");
  }

  // Формулы отрисовываем после вставки: сырой LaTeX выбрать невозможно.
  renderMath(taskList);

  // Аккордеон (02.09, решение Ильи): тап по шапке = ленивая генерация прямо
  // в карточке, мимо confirm. Клик слушает ШАПКА, не вся карточка — иначе
  // тапы по раскрытому решению схлопывали бы его.
  state.sheetTasks = tasks;
  state.taskState = new Map();
  taskList.querySelectorAll(".task-card").forEach((card) => {
    card.querySelector(".task-card-head").addEventListener("click", () => toggleTask(card, Number(card.dataset.index)));
  });
  document.querySelector("#screen-tasks .tasks-lead").textContent = "Нажми на задачу — решим её.";
}

// ---------- аккордеон решений (02.09) ----------
// Генерация ЛЕНИВАЯ (только по тапу — уже было так) и ПОСЛЕДОВАТЕЛЬНАЯ:
// стрим-слой держит один активный поток (solveStream — глобаль, события
// чужого потока отбрасываются), поэтому тап по другой задаче во время
// генерации получает подсказку, а не второй поток. Раскрытых решений может
// быть НЕСКОЛЬКО (сравнение): очередь печати element-based, контейнеры
// независимы. Экраны confirm/solution и check-путь не тронуты.

const streamBusy = () => solveStream && !solveStream.final && !solveStream.error;

/** Плашка «идёт работа» (№4, 02.09): статичный текст читался как зависание —
 * до первого шага solver молчит 5–15 с. Карандаш + многоточие анимируются
 * чистым CSS (pen-write/dot-blink); ошибки остаются простым .answer-pending
 * без анимации — там работа НЕ идёт. */
function pendingBusyMarkup(text) {
  return `<span class="pending-pen" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg></span><span>${escapeHtml(text)}<span class="pending-dots"><span>.</span><span>.</span><span>.</span></span></span>`;
}

/** Раскрытие/схлопывание с видимой границей (№2, 02.09): раскрытая карточка
 * получает акцентную рамку --open, решение — фон-«вложенный лист». */
function setTaskOpen(card, open) {
  card.querySelector(".task-acc").hidden = !open;
  card.classList.toggle("task-card--open", open);
}

function toggleTask(card, index) {
  const acc = card.querySelector(".task-acc");
  const ts = state.taskState.get(index);
  if (ts?.status === "done" || ts?.status === "streaming") {
    setTaskOpen(card, acc.hidden); // клиентский кэш: раскрытие без генерации
    return;
  }
  if (streamBusy()) {
    setTaskOpen(card, true);
    if (!acc.innerHTML) {
      acc.innerHTML = `<p class="task-busy answer-pending--busy">${pendingBusyMarkup("Дорешиваем предыдущую задачу — как допишется, нажми ещё раз")}</p>`;
    }
    return;
  }
  startTaskSolve(card, index, {});
}

/** Старт (или перезапуск после правки условия) генерации в карточку. */
function startTaskSolve(card, index, extra) {
  const task = state.sheetTasks[index];
  state.taskState.set(index, { status: "streaming", solution: null });
  setTaskOpen(card, true);
  const st = startSolveStream(
    // Без textEdited/textSource: текст задачи — производный от фото (vision),
    // это не ручной ввод и не правка. Правка условия шлёт edited (см. ниже).
    { text: task.text, grade: state.grade, subject: state.subject, ...extra },
    { allowEarlyConfirm: false, allowPrompt: false }
  );
  renderTaskStreamInto(card, index, st);
  st.promise.catch(() => {}); // сбой уже показан в карточке
}

/** Живой рендер решения в контейнер карточки — аналог renderSolutionStreaming,
 * но без синглтон-элементов экрана решения. */
function renderTaskStreamInto(card, index, st) {
  const acc = card.querySelector(".task-acc");
  flushTypeQueue(); // недопечатанное прошлой задачи доводим мгновенно, не бросаем
  acc.innerHTML = `
    <button class="task-edit-link" type="button">Исправить условие</button>
    <div class="task-edit" hidden>
      <textarea class="task-edit-text" rows="3"></textarea>
      <button class="btn-light task-edit-go" type="button">Решить заново</button>
    </div>
    <ol class="steps task-steps"></ol>
    <div class="graph-card task-extra" hidden></div>
    <div class="answer-block task-answer"><p class="answer-pending answer-pending--busy">${pendingBusyMarkup("Дорешиваем и проверяем ответ вычислением")}</p></div>
    <div class="task-actions"></div>`;
  wireTaskEdit(card, index);
  const steps = acc.querySelector(".task-steps");
  steps.innerHTML = st.steps.map((s, i) => stepMarkup(s, i, true)).join("");
  renderMath(steps);
  for (const li of steps.children) enqueueTyping(li);
  st.onStep = (step) => {
    steps.insertAdjacentHTML("beforeend", stepMarkup(step, steps.children.length, true));
    renderMath(steps.lastElementChild);
    enqueueTyping(steps.lastElementChild);
  };
  st.onDone = async (fin) => {
    st.onStep = null;
    st.onDone = null;
    await waitTypeQueue();
    if (fin && fin.code === 200 && !fin.body.multipleTasks) {
      state.failStreak = null; // успех рвёт серию
      state.taskState.set(index, { status: "done", solution: fin.body });
      renderTaskDone(card, index, fin.body);
    } else {
      // error-статус: повторный тап по шапке = новая попытка (см. toggleTask).
      state.taskState.set(index, { status: "error", solution: null });
      let msg = fin
        ? humanizeError(fin.code, { serverMessage: fin.body?.error })
        : (st.error?.message ?? "Что-то пошло не так на нашей стороне. Попробуй позже.");
      let wall = false;
      if (!fin || fin.code >= 500) {
        msg = solverFailMessage(state.sheetTasks?.[index]?.text ?? "", msg);
        wall = state.failStreak.count >= 2;
      }
      // При «стене» не зовём тапнуть ещё раз — совет уже другой.
      acc.querySelector(".task-answer").innerHTML =
        `<p class="answer-pending">${escapeHtml(msg)}${wall ? "" : " Нажми на задачу ещё раз — попробуем снова."}</p>`;
    }
  };
  if (st.final || st.error) st.onDone(st.final); // финал успел раньше подписки
}

/** Финал в карточке: графики/фигуры/схемы, ответ, «Ошибка в ответе». */
function renderTaskDone(card, index, solution) {
  const acc = card.querySelector(".task-acc");
  const steps = acc.querySelector(".task-steps");
  if (steps.children.length !== (solution.steps?.length ?? 0)) {
    // Финал пришёл фолбэк-POST'ом без стрим-шагов — дорисовываем целиком.
    steps.innerHTML = stepsMarkup(solution.steps);
    renderMath(steps);
  }
  const extra = acc.querySelector(".task-extra");
  const extraHtml = graphCardMarkup(solution.graph) + figureCardMarkup(solution.figure) + schemaCardMarkup(solution.schemaId);
  extra.innerHTML = extraHtml;
  extra.hidden = !extraHtml;
  if (extraHtml) renderMath(extra);
  const answer = acc.querySelector(".task-answer");
  answer.innerHTML = answerMarkup(solution);
  renderMath(answer);
  const actions = acc.querySelector(".task-actions");
  actions.innerHTML = `<button class="btn-light btn-report task-report" type="button">Ошибка в ответе</button>`;
  actions.querySelector(".task-report").addEventListener("click", () => taskFeedback(actions, index));
}

/** Жалоба ПРО ЭТУ задачу: контекст (условие+решение) передаётся overrides,
 * иначе при нескольких решениях на экране жалоба уехала бы с чужим текстом
 * из глобального state (решение Ильи №3). Шаблон формы — дубль feedbackForm
 * (сознательно: та вставляется относительно .sheet-actions экрана). */
function taskFeedback(actions, index) {
  let box = actions.querySelector(".feedback");
  if (!box) {
    box = document.createElement("div");
    box.className = "feedback";
    box.innerHTML = `
      <p class="feedback-title">Что не так?</p>
      <textarea class="feedback-text" rows="3"
                placeholder="Например: неправильный ответ / не та задача / ошибка в шаге 3"></textarea>
      <div class="feedback-actions">
        <button class="btn-light feedback-send" type="button">Отправить</button>
        <button class="btn-light feedback-cancel" type="button">Отмена</button>
      </div>
      <p class="feedback-status" hidden></p>`;
    actions.appendChild(box);
    const over = {
      recognizedText: state.sheetTasks?.[index]?.text ?? "",
      solutionSnapshot: state.taskState.get(index)?.solution ?? null,
    };
    box.querySelector(".feedback-cancel").addEventListener("click", () => box.remove());
    box.querySelector(".feedback-send").addEventListener("click", () => sendFeedback(box, "solve", over));
  }
  box.querySelector(".feedback-text")?.focus();
}

/** «Исправить условие»: правка → перезапуск генерации этой задачи с edited. */
function wireTaskEdit(card, index) {
  const acc = card.querySelector(".task-acc");
  const editBox = acc.querySelector(".task-edit");
  const ta = acc.querySelector(".task-edit-text");
  acc.querySelector(".task-edit-link").addEventListener("click", () => {
    editBox.hidden = !editBox.hidden;
    if (!editBox.hidden) {
      ta.value = state.sheetTasks[index].text;
      ta.focus();
    }
  });
  acc.querySelector(".task-edit-go").addEventListener("click", () => {
    const t = ta.value.trim();
    if (!t || streamBusy()) return; // пустое не шлём; генерация одна за раз
    state.sheetTasks[index].text = t;
    const head = card.querySelector(".task-card-text");
    head.innerHTML = t.split("\n").map((l) => `<p class="task-card-line">${escapeHtml(l)}</p>`).join("");
    renderMath(head);
    state.taskState.delete(index); // клиентский кэш этой задачи сброшен
    startTaskSolve(card, index, { textEdited: true, textSource: "edited" });
  });
}

document.getElementById("btn-back-tasks").addEventListener("click", () => showScreen("screen-capture"));

// ---------- экран 3: confirm ----------
// Кнопка на экране решения — назад к подтверждению условия.
document.getElementById("btn-back-confirm")?.addEventListener("click", () => showScreen("screen-confirm"));

const btnConfirm = document.getElementById("btn-confirm");

/** Ошибка на экране подтверждения. Мок-подстановки здесь нет и быть не должно:
 *  показать чужое решение вместо честной ошибки — хуже, чем не показать ничего. */
function showConfirmError(text) {
  let el = document.getElementById("confirm-error");
  if (!el) {
    el = document.createElement("p");
    el.id = "confirm-error";
    el.style.cssText =
      "margin:12px 0 0;padding:10px 12px;border-radius:12px;font-size:13px;line-height:1.4;" +
      "background:rgba(220,38,38,.12);color:#b91c1c;";
    btnConfirm.insertAdjacentElement("beforebegin", el);
  }
  el.textContent = text;
  el.hidden = false;
}

function hideConfirmError() {
  const el = document.getElementById("confirm-error");
  if (el) el.hidden = true;
}

const recognizedView = document.getElementById("recognized-view");
const btnEditText = document.getElementById("btn-edit-text");

/**
 * Показывает условие отрисованным: сырой $\\sqrt[3]{...}$ ученик прочитать не может,
 * а проверить распознавание должен именно он. Каждая строка — своим абзацем,
 * чтобы в контрольной из нескольких заданий формулы не слипались.
 */
function renderRecognizedView() {
  recognizedView.innerHTML = recognizedTextEl.value
    .split("\n")
    .map((line) => `<p class="recognized-line">${escapeHtml(line)}</p>`)
    .join("");
  // throwOnError: false внутри renderMath — кривой LaTeX останется текстом,
  // экран не упадёт, а поправить его можно через «Исправить».
  renderMath(recognizedView);
}

/**
 * Переключает просмотр и правку. Значение всегда живёт в textarea, поэтому
 * сравнение «текст менялся или нет» на кнопке «Верно, решай» работает как прежде.
 */
function setRecognizedEditing(editing) {
  recognizedTextEl.hidden = !editing;
  recognizedView.hidden = editing;
  btnEditText.textContent = editing ? "Готово" : "Исправить";
  if (editing) {
    recognizedTextEl.focus();
  } else {
    renderRecognizedView();
  }
  updateConfirmCta();
}

btnEditText.addEventListener("click", () => setRecognizedEditing(recognizedTextEl.hidden));

/** Решать нечего, пока в поле пусто: placeholder — это подсказка, а не текст задачи. */
function updateConfirmCta() {
  btnConfirm.disabled = recognizedTextEl.value.trim().length === 0;
}

recognizedTextEl.addEventListener("input", updateConfirmCta);
updateConfirmCta();

btnConfirm.addEventListener("click", async () => {
  const currentText = recognizedTextEl.value;
  const st = solveStream;
  const recognized = state.solution?.recognizedText ?? (st && !st.error ? state.recognizedText : null);
  const textUnchanged = recognized !== null && currentText.trim() === String(recognized).trim();

  // Текст не правили — решение либо уже пришло целиком, либо дописывается потоком.
  if (textUnchanged) {
    hideConfirmError();
    state.recognizedText = currentText;
    if (state.solution) {
      renderSolution(state.solution);
      showScreen("screen-solution");
      return;
    }
    if (st) {
      if (st.final && st.final.code === 200 && !st.final.body.multipleTasks) {
        state.solution = st.final.body;
        renderSolution(state.solution);
        showScreen("screen-solution");
        return;
      }
      // Поток ещё идёт (или кончился ошибкой — её покажет живой рендер).
      renderSolutionStreaming(st);
      showScreen("screen-solution");
      return;
    }
    return;
  }

  // Пользователь поправил условие — решаем заново по тексту, потоком прямо
  // на экране решения: шаги дописываются на глазах, фолбэк-POST внутри слоя.
  hideConfirmError();
  state.recognizedText = currentText;
  state.solution = null;
  const st2 = startSolveStream(
    // textEdited — телеметрии: ученик правил распознанный текст (сам текст
    // и так уходит; флаг отмечает «второй платёж» для решения о жадной схеме).
    // textSource: 'edited' — правка распознанного, в отличие от 'typed'
    // (свежий ввод с экрана съёмки): метрика «доля правок» не смешивается.
    { text: currentText, grade: state.grade, subject: state.subject, textEdited: true, textSource: "edited" },
    { allowEarlyConfirm: false, allowPrompt: false }
  );
  renderSolutionStreaming(st2);
  showScreen("screen-solution");
  st2.promise.catch(() => {}); // двойной сбой уже показан плашкой живого рендера
});

// ---------- вызов backend ----------

// Распознавание + решение: живая телеметрия показала 56–99 с на полном пути
// с фото — при прежних 60 с два запроса из семи умерли на фронте при готовом
// решении бэкенда. 150 с — как в check.
const SOLVE_TIMEOUT_MS = 150000;
// Проверка домашки поднимает три модели подряд: распознавание, эталон, сравнение.
// Замер на реальном многозадачном листе — 79,6 с; 90 с были впритык.
const CHECK_TIMEOUT_MS = 150000;

// Этапные надписи проверки. Пороги — по МЕДЛЕННОМУ листу (vision до ~16 с,
// solver до ~35 с), чтобы надпись не обгоняла реальность: на быстрых листах
// она может отставать — это допустимо, обгон — нет. Смена надписи доказывает
// ребёнку, что процесс жив (одно застывшее «Проверяем…» на 80 секунд — нет).
const CHECK_STAGES = [
  [0, "Читаем твою работу…"],
  [20000, "Решаем задачу сами, чтобы было с чем сверить…"],
  [55000, "Сверяем решение и ищем, что поправить…"],
];

// Solve-путь: фото → vision ~10–15 с, дальше solver. Пороги ниже реальности
// (правило то же: отставать можно, обгонять нельзя). Для перерешивания по
// правленому тексту — без этапа «Читаем фото».
const SOLVE_STAGES = [
  [0, "Читаем условие с фото…"],
  [15000, "Решаем задачу по шагам…"],
  [40000, "Проверяем ответ вычислением…"],
];
const SOLVE_TEXT_STAGES = [
  [0, "Решаем задачу по шагам…"],
  [30000, "Проверяем ответ вычислением…"],
];

let stageTimers = [];
function startStages(btn, stages) {
  stopStages();
  for (const [delay, label] of stages) {
    stageTimers.push(setTimeout(() => { btn.textContent = label; }, delay));
  }
}
function stopStages() {
  for (const t of stageTimers) clearTimeout(t);
  stageTimers = [];
}
// Прежние имена — те же функции: механизм один, вторых таймеров нет.
const startCheckStages = (btn) => startStages(btn, CHECK_STAGES);
const stopCheckStages = stopStages;

/**
 * Превращает любой сбой в фразу, понятную школьнику.
 * Единая точка для обоих путей — фото и текста, чтобы «Failed to fetch»
 * и «Бэкенд ответил 413» не доходили до экрана.
 *
 * @param {number|null} status - HTTP-статус, либо null если ответа не было вовсе
 * @param {object} [err] - исходная ошибка и/или сообщение бэкенда
 */
// ---------- экран подписки (gating) ----------
// Ссылка канала подтверждена живым GET /chats 31.08.2026.
const CHANNEL_URL = "https://max.ru/id772408566819_biz";
let subscribeReturnScreen = "screen-setup";

/** Помечает ошибку гейтинга; экран показывается из верхних обработчиков. */
function markNotSubscribed(err) {
  if (err.status === 403 && err.body?.error === "not_subscribed") err.notSubscribed = true;
}

function showSubscribeScreen() {
  const active = document.querySelector('.screen[data-active="true"]')?.id;
  if (active && active !== "screen-subscribe") subscribeReturnScreen = active;
  const status = document.getElementById("subscribe-status");
  if (status) { status.hidden = true; status.textContent = ""; }
  showScreen("screen-subscribe");
}

document.getElementById("btn-open-channel")?.addEventListener("click", () => {
  // openMaxLink открывает max.ru-ссылку внутри клиента MAX; вне MAX — новая вкладка.
  if (window.WebApp?.openMaxLink) window.WebApp.openMaxLink(CHANNEL_URL);
  else window.open(CHANNEL_URL, "_blank");
});

document.getElementById("btn-recheck-sub")?.addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const status = document.getElementById("subscribe-status");
  btn.disabled = true;
  status.hidden = false;
  status.textContent = "Проверяю…";
  try {
    const r = await postJson("/api/subscription/recheck", {}, 10000);
    if (r.status === "subscribed") {
      status.textContent = "Готово! Подписка на месте.";
      setTimeout(() => showScreen(subscribeReturnScreen), 700);
    } else if (r.status === "no_user") {
      status.textContent = "Не получилось узнать, кто ты. Закрой и открой приложение из MAX заново.";
    } else if (r.status === "error") {
      status.textContent = "Не получилось проверить. Попробуй ещё раз через пару секунд.";
    } else {
      status.textContent = "Пока не видим подписку. Если подписался только что — подожди пару секунд и нажми ещё раз.";
    }
  } catch {
    status.textContent = "Не получилось проверить. Попробуй ещё раз.";
  } finally {
    // Сервер лимитирует принудительную проверку раз в 5 секунд — кнопка тоже.
    setTimeout(() => { btn.disabled = false; }, 5000);
  }
});

function humanizeError(status, err) {
  if (err?.name === "AbortError") {
    return "Сервер долго не отвечает. Попробуй ещё раз.";
  }
  if (status === null || status === undefined) {
    return "Нет связи с сервером. Проверь интернет и попробуй снова.";
  }
  if (status === 413) {
    return "Фото слишком большое. Сними одну задачу крупнее или сожми снимок.";
  }
  // 4xx бэкенд формулирует для ученика сам (422 «переснимите», 400 про формат файла) —
  // такой текст показываем как есть, он точнее любого общего.
  if (status < 500 && err?.serverMessage) {
    return err.serverMessage;
  }
  return "Что-то пошло не так на нашей стороне. Попробуй позже.";
}

/**
 * Запрос к бэкенду: ошибки НЕ маскирует и ничем не подменяет.
 * Наружу отдаёт уже человеческий текст в err.message.
 */
async function postJson(path, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Бесплатный ngrok показывает браузеру HTML-заглушку вместо ответа API;
        // этот заголовок её отключает. На проде безвреден.
        "ngrok-skip-browser-warning": "true",
        // Подписанная строка запуска: бэкенд проверяет её и понимает, кто пришёл.
        ...(max.initData ? { "X-Max-Init-Data": max.initData } : {}),
        ...(window.APP_VERSION ? { "X-App-Version": window.APP_VERSION } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(humanizeError(res.status, { serverMessage: data?.error }));
      err.status = res.status;
      err.body = data;
      markNotSubscribed(err);
      throw err;
    }
    return data;
  } catch (err) {
    if (err.status) throw err;                       // ответ был, текст уже человеческий
    throw new Error(humanizeError(null, err));       // обрыв связи либо таймаут
  } finally {
    clearTimeout(timer);
  }
}


// ---------- отрисовка формул (KaTeX) ----------
// Бэкенд возвращает шаги с формулами в LaTeX внутри $...$. Без отрисовки ученик
// видит сырые $ и \dfrac{}{} — это мусор на экране, а не решение.
const MATH_DELIMITERS = [
  { left: "$$", right: "$$", display: true },
  { left: "\\[", right: "\\]", display: true },
  { left: "$", right: "$", display: false },
  { left: "\\(", right: "\\)", display: false },
];

/**
 * Отрисовывает формулы внутри уже вставленного в DOM элемента.
 * Вызывать только ПОСЛЕ вставки: auto-render работает по живому дереву.
 *
 * Экран подтверждения (textarea#recognized-text) сюда намеренно не попадает —
 * там текст остаётся редактируемым сырым, ученик его правит руками.
 */
function renderMath(root) {
  if (typeof window.renderMathInElement !== "function") {
    // KaTeX не загрузился (нет сети, CDN недоступен) — оставляем текст как есть,
    // это хуже на вид, но лучше, чем пустой экран.
    console.warn("KaTeX недоступен, формулы остаются текстом");
    return;
  }
  try {
    window.renderMathInElement(root, {
      delimiters: MATH_DELIMITERS,
      throwOnError: false, // кривую формулу показываем как текст, не роняем экран
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
    });
  } catch (err) {
    console.warn("KaTeX не смог отрисовать формулы:", err);
  }
}

// ---------- экран 4: решение (светлый стиль A, docs/design-spec.md) ----------
// Свайпа нет: всё решение одним вертикальным списком, шаги пронумерованы кружками.
const stepsList = document.getElementById("steps-list");
const graphCard = document.getElementById("graph-card");
const answerBlock = document.getElementById("answer-block");
const solutionTask = document.getElementById("solution-task");
const btnNewTask = document.getElementById("btn-new-task");
const btnReport = document.getElementById("btn-report");
const solutionScreen = document.getElementById("screen-solution");

/**
 * Строка проверки под ответом — показывается ТОЛЬКО когда ответ реально сверен.
 *
 * SymPy берёт лишь то, что сводится к уравнениям: геометрические построения,
 * доказательства и гуманитарные предметы верифицировать нечем. Постоянная серая
 * пометка «не проверено» на них создавала бы ложную тревогу и обесценивала бы
 * саму галочку. Молчание — не выдача непроверенного за проверенное: галочка
 * появляется исключительно при настоящей верификации.
 */
function verificationRow(verification) {
  if (verification?.verified !== true) return "";
  return `<p class="answer-verify" data-verified="true">
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="m9 12 2 2 4-4" />
    </svg><span>Ответ проверен вычислением</span></p>`;
}

// ---------- markdown-таблицы в шагах ----------
// Solver может оформить сравнение или образец записи |-таблицей (разрешено
// промптом). Парсим ТОЛЬКО этот узкий диалект: подряд идущие строки на «|»,
// вторая — разделитель |---|. Всё остальное остаётся обычным текстом.
// Ячейки прогоняются через escapeHtml; KaTeX по ним пройдёт после вставки.
function tableMarkup(lines) {
  const rows = lines.map((l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim()));
  const head = rows[0];
  const body = rows.slice(2); // [1] — разделитель |---|
  const tr = (cells, tag) => `<tr>${cells.map((c) => `<${tag}>${escapeHtml(c)}</${tag}>`).join("")}</tr>`;
  return `<div class="step-table-wrap"><table class="step-table"><thead>${tr(head, "th")}</thead><tbody>${body.map((r) => tr(r, "td")).join("")}</tbody></table></div>`;
}

/** **жирный** → <strong> на УЖЕ экранированной строке (модель пишет так в ~2% решений). */
function inlineMarkup(escapedLine) {
  return escapedLine.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
}

/** Текст шага → HTML: строки экранируются, |-таблицы → <table>, ```-блоки → <pre>
 *  (запись столбиком/уголком — моноширинно, выравнивание разрядов сохраняется).
 *
 *  typing=true — режим пословной печати: та же сегментация, тот же проход
 *  (второго парсера нет), но печатные единицы оборачиваются в невидимые
 *  <span class="tw">, которые потом проявляет очередь печати. Единица —
 *  слово; формула $...$, таблица и ```-блок АТОМАРНЫ (появляются целиком:
 *  полформулы и полтаблицы — мусор). Вся вёрстка построена заранее, слова
 *  лишь становятся видимыми — переносы строк не дёргаются. Пословный **жирный**
 *  внутри одного слова работает; жирный через пробел в typing-режиме
 *  деградирует до звёздочек (5 решений из 323 — принято осознанно). */
const TW = (inner) => `<span class="tw" style="visibility:hidden">${inner}</span>`;

function typedTextLine(rawLine) {
  // Сначала формулы: $...$ — один атом; остальное — пословно.
  return rawLine
    .split(/(\$[^$\n]*\$)/)
    .map((tok) => {
      if (/^\$[^$\n]*\$$/.test(tok)) return TW(escapeHtml(tok));
      return tok
        .split(/(\s+)/)
        .map((w) => (/^\s*$/.test(w) ? w : TW(inlineMarkup(escapeHtml(w)))))
        .join("");
    })
    .join("");
}

function stepContentMarkup(content, typing = false) {
  const lines = String(content ?? "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const isTableLine = (n) => /^\s*\|.*\|\s*$/.test(lines[n] ?? "");
    const isSeparator = (n) => /^\s*\|[\s:|-]+\|\s*$/.test(lines[n] ?? "");
    const isFence = (n) => /^\s*```/.test(lines[n] ?? "");
    if (isFence(i)) {
      const block = [];
      i++; // открывающее ```
      while (i < lines.length && !isFence(i)) block.push(lines[i++]);
      i++; // закрывающее ``` (или конец текста)
      const pre = `${escapeHtml(block.join("\n"))}`;
      out.push(typing ? `<span class="step-pre tw" style="visibility:hidden">${pre}</span>` : `<span class="step-pre">${pre}</span>`);
    } else if (isTableLine(i) && isSeparator(i + 1) && isTableLine(i + 1)) {
      const block = [];
      while (i < lines.length && isTableLine(i)) block.push(lines[i++]);
      const table = tableMarkup(block);
      out.push(typing ? TW(table) : table);
    } else if (typing) {
      out.push(typedTextLine(lines[i++]));
    } else {
      out.push(inlineMarkup(escapeHtml(lines[i++])));
    }
  }
  return out.join("\n");
}

/** Разметка одного шага — из неё собирается список и дорисовка при стриминге. */
function stepMarkup(step, i, typing = false) {
  return `
      <li class="step">
        <span class="step-num">${i + 1}</span>
        <div class="step-body">
          <h2 class="step-title">${escapeHtml(step.title)}</h2>
          <p class="step-text">${stepContentMarkup(step.content, typing)}</p>
        </div>
      </li>`;
}

/** Разметка списка шагов — одна на экран решения и на эталон внутри проверки. */
function stepsMarkup(steps) {
  return steps.map(stepMarkup).join("");
}


// Единая карточка наглядности (бэкенд отдаёт поле figure, уже нормализованное
// валидатором services/figure.js; старый кэш конвертируется там же на лету).
/** Чистая разметка карточки фигуры ("" — карточка не нужна). Извлечено из
 * renderFigureCard, чтобы аккордеон задач рендерил те же карточки в свои
 * контейнеры; сам renderFigureCard — тонкая DOM-обёртка (экран решения). */
function figureCardMarkup(figure) {
  const svg =
    figure?.kind === "circles" ? circlesSvg({ circlesTotal: figure.circlesTotal, circlesCrossed: figure.circlesCrossed, circlesGroupSize: figure.circlesGroupSize })
    : figure?.kind === "numberline" ? numberlineSvg({ points: figure.points, range: figure.range })
    : figure?.kind === "rectangle" || figure?.kind === "square" ? drawingSvg(figure)
    : figure?.kind === "adjacent-angles" ? adjacentAnglesSvg(figure)
    : figure?.kind === "vertical-angles" ? verticalAnglesSvg(figure)
    : figure?.kind === "parallel-lines" ? parallelLinesSvg(figure)
    : figure?.kind === "triangle" ? triangleSvg(figure)
    : figure?.kind === "parallelogram" ? parallelogramSvg(figure)
    : figure?.kind === "rhombus" ? rhombusSvg(figure)
    : figure?.kind === "trapezoid" ? trapezoidSvg(figure)
    : "";
  if (!svg) return "";
  const comment = figure.comment ? `<p class="graph-comment">${escapeHtml(figure.comment)}</p>` : "";
  return svg + comment;
}

function renderFigureCard(figure) {
  const card = document.getElementById("figure-card");
  if (!card) return;
  const html = figureCardMarkup(figure);
  if (!html) { card.hidden = true; card.innerHTML = ""; return; }
  card.innerHTML = html;
  card.hidden = false;
  renderMath(card);
}

// Библиотека готовых схем (пилот №12, группа В): статические SVG, нарисованы
// и проверены заранее — модель только ВЫБИРАЕТ id, ничего не генерируя.
const SCHEMA_LIBRARY = {
  "термометр": { file: "termometr.svg", alt: "Устройство термометра: шкала, трубка с жидкостью, резервуар" },
  "части-растения": { file: "chasti-rasteniya.svg", alt: "Части растения: корень, стебель, лист, цветок" },
  "стороны-горизонта": { file: "storony-gorizonta.svg", alt: "Стороны горизонта: основные и промежуточные" },
  "большая-медведица": { file: "bolshaya-medveditsa.svg", alt: "Ковш Большой Медведицы и Полярная звезда" },
};

/** Чистая разметка готовой схемы ("" — нет такой в библиотеке). */
function schemaCardMarkup(schemaId) {
  const entry = SCHEMA_LIBRARY[schemaId];
  if (!entry) return "";
  return `<img src="assets/schemas/${entry.file}" alt="${escapeHtml(entry.alt)}" style="width:100%;height:auto" loading="lazy">`;
}

function renderSchemaCard(schemaId) {
  const card = document.getElementById("schema-card");
  if (!card) return;
  const html = schemaCardMarkup(schemaId);
  if (!html) { card.hidden = true; card.innerHTML = ""; return; }
  card.innerHTML = html;
  card.hidden = false;
}

/** Чистая разметка карточки графика ("" — графика нет). */
function graphCardMarkup(graph) {
  if (!graph?.plots?.length) return "";
  const comment = graph.comment
    ? `<p class="graph-comment">${escapeHtml(graph.comment)}</p>`
    : "";
  return graphSvg(graph) + comment;
}

function renderGraphCard(graph) {
  const html = graphCardMarkup(graph);
  if (!html) {
    graphCard.hidden = true;
    graphCard.innerHTML = "";
    return;
  }
  graphCard.innerHTML = html;
  graphCard.hidden = false;
  renderMath(graphCard); // comment может содержать $...$
}

/** Разметка блока ответа вместе со строкой верификации. */
function answerMarkup(solution) {
  return `
    <p class="answer-label">Ответ</p>
    <p class="answer-value">${escapeHtml(solution.finalAnswer)}</p>
    ${verificationRow(solution.verification)}
  `;
}

function renderSolution(solution) {
  // Краткое условие в шапке — чтобы было видно, что именно решаем.
  solutionTask.textContent = state.recognizedText || "";

  stepsList.innerHTML = stepsMarkup(solution.steps);
  renderGraphCard(solution.graph);
  renderFigureCard(solution.figure);
  renderSchemaCard(solution.schemaId);
  answerBlock.innerHTML = answerMarkup(solution);

  // Формулы отрисовываем после того, как всё уже в DOM.
  renderMath(stepsList);
  renderMath(answerBlock);

  resetFeedback(solutionScreen);
  solutionScreen.querySelector(".sheet-scroll").scrollTop = 0;
}

btnNewTask.addEventListener("click", () => {
  startNewTask();
  showScreen("screen-capture");
});

// ---------- сообщение об ошибке в ответе / проверке ----------
// Жалоба реально уходит на /api/feedback и сохраняется в базе, поэтому «спасибо»
// здесь честное. Фотографии не отправляются — только текст и структура показанного.
const FEEDBACK_TIMEOUT_MS = 15000;

/** over — контекст конкретной задачи (аккордеон): при нескольких решениях
 * на экране глобальный state указывал бы на чужую задачу. Без over —
 * прежнее поведение (экраны решения/проверки). */
function feedbackPayload(type, comment, over = {}) {
  return {
    type,
    grade: state.grade,
    subject: state.subject,
    recognizedText: state.recognizedText,
    solutionSnapshot: type === "check" ? state.check : state.solution,
    userComment: comment,
    ...over,
  };
}

/** Создаёт форму жалобы внутри своего экрана (их два) либо возвращает уже созданную. */
function feedbackForm(screen, type) {
  let box = screen.querySelector(".feedback");
  if (box) return box;

  box = document.createElement("div");
  box.className = "feedback";
  box.innerHTML = `
    <p class="feedback-title">Что не так?</p>
    <textarea class="feedback-text" rows="3"
              placeholder="Например: неправильный ответ / не та задача / ошибка в шаге 3"></textarea>
    <div class="feedback-actions">
      <button class="btn-light feedback-send" type="button">Отправить</button>
      <button class="btn-light feedback-cancel" type="button">Отмена</button>
    </div>
    <p class="feedback-status" hidden></p>`;
  screen.querySelector(".sheet-actions")?.insertAdjacentElement("beforebegin", box);

  box.querySelector(".feedback-cancel").addEventListener("click", () => box.remove());
  box.querySelector(".feedback-send").addEventListener("click", () => sendFeedback(box, type));
  return box;
}

async function sendFeedback(box, type, over = {}) {
  const send = box.querySelector(".feedback-send");
  const status = box.querySelector(".feedback-status");
  const comment = box.querySelector(".feedback-text").value;

  status.hidden = true;
  setButtonBusy(send, true, "Отправляем…");
  try {
    await postJson("/api/feedback", feedbackPayload(type, comment, over), FEEDBACK_TIMEOUT_MS);
    // Жалоба записана в базу — только теперь можно благодарить.
    box.innerHTML = `<p class="feedback-done">Спасибо, передали на проверку</p>`;
  } catch (err) {
    // Не делаем вид, что отправлено: показываем причину и оставляем форму с текстом.
    status.textContent = err.message;
    status.hidden = false;
    setButtonBusy(send, false);
  }
}

/** Убирает форму при перерисовке экрана: новая задача — новая жалоба. */
function resetFeedback(screen) {
  screen.querySelector(".feedback")?.remove();
}

btnReport.addEventListener("click", () => {
  feedbackForm(solutionScreen, "solve").querySelector(".feedback-text").focus();
});

// ---------- экран 5: результат проверки домашней работы ----------
// Подключение готового POST /api/check-homework. Тон подачи спокойный: учебная
// ошибка — часть учёбы, а не провал, поэтому тревожный красный здесь не используется.
const checkScreen = document.getElementById("screen-check");
const checkVerdict = document.getElementById("check-verdict");
const checkConflict = document.getElementById("check-conflict");
const checkStudentSteps = document.getElementById("check-student-steps");
const checkMistakes = document.getElementById("check-mistakes");
const checkAnswerCheck = document.getElementById("check-answer-check");
const checkUnreadable = document.getElementById("check-unreadable");
const checkReference = document.getElementById("check-reference");
const checkReferenceBody = document.getElementById("check-reference-body");

const ICON_OK = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="12" r="9" /><path d="m9 12 2 2 4-4" /></svg>`;

const ICON_LOOK = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></svg>`;

function renderCheck(result) {
  const c = result.comparison ?? {};
  const ok = c.isCorrect === true;

  // Вердикт. «Есть что поправить» вместо «ошибка» — разбираем, а не отчитываем.
  const sub = [];
  if (c.incomplete) sub.push("Решение не дописано до ответа");
  if (!ok && c.firstMistakeStep) sub.push(`Разберём шаг ${c.firstMistakeStep}`);
  checkVerdict.className = "verdict";
  checkVerdict.dataset.ok = String(ok);
  checkVerdict.innerHTML = `
    <span>${ok ? ICON_OK : ICON_LOOK}</span>
    <div>
      <p class="verdict-title">${ok ? "Всё верно" : "Есть что поправить"}</p>
      ${sub.length ? `<p class="verdict-sub">${sub.join(" · ")}</p>` : ""}
    </div>`;

  // «Ответ верный, но в решении ошибка» — поддерживающая заметка от бэкенда.
  // Прежняя плашка «проверки разошлись / доверять нельзя» с экрана убрана:
  // расхождения вердиктов бэкенд полностью пишет в свой лог.
  if (result.answerNote) {
    checkConflict.innerHTML = `
      <div class="check-note" data-kind="answer-note">
        <div>${escapeHtml(result.answerNote)}</div>
      </div>`;
  } else {
    checkConflict.innerHTML = "";
  }

  // Работа ученика как есть, с подсветкой шага, с которого началась ошибка.
  const steps = c.studentSteps ?? [];
  checkStudentSteps.innerHTML = steps
    .map(
      (line, i) => `
      <li class="student-step" data-first-mistake="${c.firstMistakeStep === i + 1}">
        <span class="student-step-num">${i + 1}</span>
        <span>${escapeHtml(line)}</span>
      </li>`
    )
    .join("");

  // Разбор: что получилось и как лучше — разными полями, как их и отдаёт бэкенд.
  const mistakes = c.mistakes ?? [];
  checkMistakes.innerHTML = mistakes.length
    ? `<h2 class="check-section">Давай разберём</h2>` +
      mistakes
        .map(
          (m) => `
        <div class="mistake">
          <p class="mistake-where">${escapeHtml(m.stepDescription)}</p>
          <p class="mistake-label">Что получилось</p>
          <p class="mistake-text">${escapeHtml(m.whatStudentDid)}</p>
          <p class="mistake-label">Как лучше</p>
          <p class="mistake-text mistake-better">${escapeHtml(m.whatShouldBeDone)}</p>
        </div>`
        )
        .join("")
    : "";

  // Объективная сверка ответа. Спорим только когда SymPy реально посчитал.
  const a = result.answerCheck ?? {};
  if (a.method === "sympy") {
    const missing = a.details?.missing ?? [];
    const extra = a.details?.extra ?? [];
    const detail = [
      missing.length ? `не хватает: ${missing.join(", ")}` : "",
      extra.length ? `лишнее: ${extra.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    checkAnswerCheck.innerHTML = `
      <div class="check-note" data-kind="${a.verified ? "verified" : "plain"}">
        <span>${a.verified ? ICON_OK : ICON_LOOK}</span>
        <div>Ответ сверен вычислением: ${a.verified ? "совпадает" : "не совпадает"}${detail ? `<br>${detail}` : ""}</div>
      </div>`;
  } else {
    // Сверить было нечем — молчим по той же причине, что и на экране решения.
    checkAnswerCheck.innerHTML = "";
  }

  // Нечитаемое — не вина ученика, так и пишем.
  const unreadable = c.unreadableFragments ?? [];
  checkUnreadable.innerHTML = unreadable.length
    ? `<div class="check-note">
         <div>
           <strong>Не удалось разобрать на фото</strong>
           <ul>${unreadable.map((u) => `<li>${escapeHtml(u)}</li>`).join("")}</ul>
           Это не считается ошибкой. Если фрагмент важен — переснимите его крупнее.
         </div>
       </div>`
    : "";

  // Эталон отдельным свёрнутым блоком: сначала своя работа, потом готовое решение.
  const ref = result.referenceSolution;
  checkReference.open = false;
  checkReferenceBody.innerHTML = ref
    ? `<ol class="steps">${stepsMarkup(ref.steps)}</ol>
       <div class="answer-block">${answerMarkup(ref)}</div>`
    : "";

  renderMath(checkScreen);
  resetFeedback(checkScreen);
  document.getElementById("check-scroll").scrollTop = 0;
}

document.getElementById("btn-back-check").addEventListener("click", () => showScreen("screen-capture"));

document.getElementById("btn-new-check").addEventListener("click", () => {
  startNewTask();
  showScreen("screen-capture");
});

document.getElementById("btn-report-check").addEventListener("click", () => {
  feedbackForm(checkScreen, "check").querySelector(".feedback-text").focus();
});

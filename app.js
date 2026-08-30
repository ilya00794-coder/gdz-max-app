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
};

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
      },
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(humanizeError(res.status, { serverMessage: data?.error }));
      err.status = res.status;
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
function showPhoto() {
  captureEmpty.hidden = true;
  capturePhoto.hidden = false;
  cropTip.hidden = false;

  cropImage.onload = () => {
    const w = cropImage.clientWidth;
    const h = cropImage.clientHeight;
    const n = state.photo?.cropNorm;
    // Рамку храним в долях, а не в пикселях: размер картинки на экране
    // зависит от устройства и ориентации.
    cropRect = n
      ? { x: n.x * w, y: n.y * h, w: n.w * w, h: n.h * h }
      : { x: w * 0.1, y: h * 0.1, w: w * 0.8, h: h * 0.8 };
    drawCropBox();
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
  cropTip.hidden = true;
  captureEmpty.hidden = false;
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
  resetPhoto();
  state.recognizedText = "";
  state.solution = null;
  state.check = null;
  recognizedTextEl.value = "";
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

btnSolve.addEventListener("click", async () => {
  hideCaptureError();
  hideModePrompt();

  // Фото нет — это не ошибка, а сценарий «введу условие сам»: идём на confirm с пустым полем.
  // Подсказка живёт в placeholder, а не в value: иначе ученик отправил бы чужой пример.
  if (!state.photo) {
    state.solution = null;
    state.recognizedText = "";
    recognizedTextEl.value = "";
    // Показывать нечего — сразу поле ввода.
    setRecognizedEditing(true);
    showScreen("screen-confirm");
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
  setButtonBusy(btnSolve, true, check ? "Читаем твою работу…" : "Распознаём…");
  if (check) startCheckStages(btnSolve);
  try {
    const result = check
      // Проверка последовательно поднимает три модели, отсюда увеличенный таймаут.
      ? await postJson("/api/check-homework", payload, CHECK_TIMEOUT_MS)
      : await postJson("/api/solve", payload, SOLVE_TIMEOUT_MS);

    const suggested = allowPrompt ? suggestedMode(mode, result.recognition?.contentType) : null;
    if (suggested) {
      pendingResult = { mode, payload, result, suggested };
      showModePrompt(suggested);
      return;
    }
    showResult(mode, result);
  } catch (err) {
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
  if (mode === "check" && contentType === "printed_task") return "solve";
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
  return `
    <li class="task-card" data-index="${index}">
      <p class="task-card-num">${label}</p>
      <div class="task-card-text">${text}</div>
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

  taskList.querySelectorAll(".task-card").forEach((card) => {
    card.addEventListener("click", () => selectTask(tasks[Number(card.dataset.index)]));
  });
}

function selectTask(task) {
  // Решение из первого ответа относилось ко всему снимку сразу, к выбранной
  // задаче оно не подходит — сбрасываем, чтобы экран подтверждения решил заново.
  state.solution = null;
  state.recognizedText = task.text;
  recognizedTextEl.value = task.text;
  setRecognizedEditing(false);
  showScreen("screen-confirm");
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
  const recognized = state.solution?.recognizedText ?? null;
  const textUnchanged = recognized !== null && currentText.trim() === recognized.trim();

  // Текст не правили — решение уже пришло вместе с распознаванием, второй запрос не нужен.
  if (textUnchanged) {
    hideConfirmError();
    state.recognizedText = currentText;
    renderSolution(state.solution);
    showScreen("screen-solution");
    return;
  }

  // Пользователь поправил условие — решаем заново уже по тексту, без фото.
  hideConfirmError();
  setButtonBusy(btnConfirm, true, "Решаем…");
  try {
    state.recognizedText = currentText;
    state.solution = await postJson(
      "/api/solve",
      { text: currentText, grade: state.grade, subject: state.subject },
      SOLVE_TIMEOUT_MS
    );
    renderSolution(state.solution);
    showScreen("screen-solution");
  } catch (err) {
    // Никакой подстановки готового решения: ученик должен узнать, что решения нет.
    showConfirmError(err.message);
  } finally {
    setButtonBusy(btnConfirm, false);
  }
});

// ---------- вызов backend ----------

// Распознавание + решение реально занимают 30–40 секунд, поэтому запас большой.
const SOLVE_TIMEOUT_MS = 60000;
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

let checkStageTimers = [];
function startCheckStages(btn) {
  stopCheckStages();
  for (const [delay, label] of CHECK_STAGES) {
    checkStageTimers.push(setTimeout(() => { btn.textContent = label; }, delay));
  }
}
function stopCheckStages() {
  for (const t of checkStageTimers) clearTimeout(t);
  checkStageTimers = [];
}

/**
 * Превращает любой сбой в фразу, понятную школьнику.
 * Единая точка для обоих путей — фото и текста, чтобы «Failed to fetch»
 * и «Бэкенд ответил 413» не доходили до экрана.
 *
 * @param {number|null} status - HTTP-статус, либо null если ответа не было вовсе
 * @param {object} [err] - исходная ошибка и/или сообщение бэкенда
 */
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
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(humanizeError(res.status, { serverMessage: data?.error }));
      err.status = res.status;
      err.body = data;
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

/**
 * Экранирует текст перед вставкой через innerHTML.
 *
 * Это не только про безопасность. Тексты приходят от модели и полны математики:
 * «16-20<0», «a<b», «x>0». Без экранирования браузер принимает «<b» за начало тега
 * и молча съедает кусок решения. KaTeX это не мешает — он читает текстовые узлы,
 * где сущности уже разобраны обратно в символы.
 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
const visualCard = document.getElementById("visual-card");
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
 *  (запись столбиком/уголком — моноширинно, выравнивание разрядов сохраняется). */
function stepContentMarkup(content) {
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
      out.push(`<span class="step-pre">${escapeHtml(block.join("\n"))}</span>`);
    } else if (isTableLine(i) && isSeparator(i + 1) && isTableLine(i + 1)) {
      const block = [];
      while (i < lines.length && isTableLine(i)) block.push(lines[i++]);
      out.push(tableMarkup(block));
    } else {
      out.push(inlineMarkup(escapeHtml(lines[i++])));
    }
  }
  return out.join("\n");
}

/** Разметка списка шагов — одна на экран решения и на эталон внутри проверки. */
function stepsMarkup(steps) {
  return steps
    .map(
      (step, i) => `
      <li class="step">
        <span class="step-num">${i + 1}</span>
        <div class="step-body">
          <h2 class="step-title">${escapeHtml(step.title)}</h2>
          <p class="step-text">${stepContentMarkup(step.content)}</p>
        </div>
      </li>`
    )
    .join("");
}

// ---------- график функции: свой SVG, без библиотек ----------
//
// Данные приходят готовыми с бэкенда (verify_sympy mode=plot): points с
// возможными y:null (разрывы), zeros, extrema, asymptotes. Модель координат
// не выдаёт — рисуем только посчитанное SymPy.

const GRAPH_W = 340;
const GRAPH_H = 210;
const GRAPH_PAD = { top: 12, right: 14, bottom: 24, left: 34 };
const GRAPH_ACCENT = "#185FA5";
const GRAPH_GREY = "#C8C7C0";

/** Число для подписи: до двух знаков, без хвостовых нулей, запятая как в тетради. */
function graphNumber(value) {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded).replace(".", ",").replace("-", "−");
}

/**
 * Окно по y: у функций с асимптотами значения улетают в тысячи, и без обрезки
 * весь график схлопнулся бы в горизонтальную линию. Берём срединные 88%
 * значений, но обязательно включаем ось x, экстремумы и горизонтальные
 * асимптоты — то, что должно быть видно всегда.
 */
function graphYWindow(graph) {
  const ys = [];
  for (const plot of graph.plots) {
    for (const [, y] of plot.points) if (y !== null) ys.push(y);
  }
  if (!ys.length) return null;
  ys.sort((a, b) => a - b);
  let lo = ys[Math.floor(ys.length * 0.06)];
  let hi = ys[Math.ceil(ys.length * 0.94) - 1];
  const mustSee = [0];
  for (const plot of graph.plots) {
    for (const e of plot.extrema) mustSee.push(e.y);
    for (const h of plot.asymptotes.horizontal) mustSee.push(h);
  }
  lo = Math.min(lo, ...mustSee);
  hi = Math.max(hi, ...mustSee);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  // Границы округляем до «красивых» значений (шаг 1, 2, 5, 10 и кратные),
  // как на осях в учебнике: подпись «−9,72» на краю оси только путает.
  const step = graphNiceStep(hi - lo);
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step };
}

/** Красивый шаг оси: 1, 2, 5 или 10, умноженные на степень десятки. */
function graphNiceStep(range) {
  const power = Math.pow(10, Math.floor(Math.log10(range / 5)));
  for (const mult of [1, 2, 5, 10]) {
    if (range / (mult * power) <= 6) return mult * power;
  }
  return 10 * power;
}

/** Точка пересечения двух полилиний (для системы — это и есть ответ). */
function graphIntersections(plots) {
  if (plots.length !== 2) return [];
  const [a, b] = plots;
  const found = [];
  for (let i = 1; i < a.points.length && found.length < 3; i++) {
    const [x0, ya0] = a.points[i - 1], [x1, ya1] = a.points[i];
    const yb0 = b.points[i - 1][1], yb1 = b.points[i][1];
    if (ya0 === null || ya1 === null || yb0 === null || yb1 === null) continue;
    const d0 = ya0 - yb0, d1 = ya1 - yb1;
    if (d0 === 0) { found.push([x0, ya0]); continue; }
    if (d0 * d1 < 0) {
      const t = d0 / (d0 - d1);
      found.push([x0 + t * (x1 - x0), ya0 + t * (ya1 - ya0)]);
    }
  }
  return found;
}

/** Собирает SVG-разметку графика. Внутрь попадают только числа — экранировать нечего. */
function graphSvg(graph) {
  const win = graphYWindow(graph);
  if (!win) return "";
  const [xa, xb] = graph.plots[0].xRange;
  const plotW = GRAPH_W - GRAPH_PAD.left - GRAPH_PAD.right;
  const plotH = GRAPH_H - GRAPH_PAD.top - GRAPH_PAD.bottom;
  const sx = (x) => GRAPH_PAD.left + ((x - xa) / (xb - xa)) * plotW;
  const sy = (y) => GRAPH_PAD.top + ((win.hi - y) / (win.hi - win.lo)) * plotH;
  const inWin = (y) => y !== null && y >= win.lo && y <= win.hi;

  const parts = [];

  // Оси: x — на y=0 (окно всегда включает 0), y — на x=0 либо у левого края.
  const axisY = sy(0);
  const axisX = xa <= 0 && 0 <= xb ? sx(0) : GRAPH_PAD.left;
  parts.push(`<line x1="${GRAPH_PAD.left}" y1="${axisY}" x2="${GRAPH_W - GRAPH_PAD.right}" y2="${axisY}" stroke="#B4B3AC" stroke-width="1"/>`);
  parts.push(`<line x1="${axisX}" y1="${GRAPH_PAD.top}" x2="${axisX}" y2="${GRAPH_H - GRAPH_PAD.bottom}" stroke="#B4B3AC" stroke-width="1"/>`);
  // Подписи осей и краёв — засечек мало, сетки нет.
  parts.push(`<text x="${GRAPH_W - GRAPH_PAD.right}" y="${axisY - 5}" font-size="11" fill="#888780" text-anchor="end">x</text>`);
  parts.push(`<text x="${axisX + 5}" y="${GRAPH_PAD.top + 9}" font-size="11" fill="#888780">y</text>`);
  parts.push(`<text x="${sx(xa)}" y="${GRAPH_H - 8}" font-size="11" fill="#888780" text-anchor="start">${graphNumber(xa)}</text>`);
  parts.push(`<text x="${sx(xb)}" y="${GRAPH_H - 8}" font-size="11" fill="#888780" text-anchor="end">${graphNumber(xb)}</text>`);
  parts.push(`<text x="${GRAPH_PAD.left - 4}" y="${sy(win.hi) + 10}" font-size="11" fill="#888780" text-anchor="end">${graphNumber(win.hi)}</text>`);
  parts.push(`<text x="${GRAPH_PAD.left - 4}" y="${sy(win.lo)}" font-size="11" fill="#888780" text-anchor="end">${graphNumber(win.lo)}</text>`);

  // Асимптоты — тонкий серый пунктир.
  for (const plot of graph.plots) {
    for (const v of plot.asymptotes.vertical) {
      if (v < xa || v > xb) continue;
      parts.push(`<line x1="${sx(v)}" y1="${GRAPH_PAD.top}" x2="${sx(v)}" y2="${GRAPH_H - GRAPH_PAD.bottom}" stroke="${GRAPH_GREY}" stroke-width="1" stroke-dasharray="4 4"/>`);
    }
    for (const h of plot.asymptotes.horizontal) {
      if (h < win.lo || h > win.hi) continue;
      parts.push(`<line x1="${GRAPH_PAD.left}" y1="${sy(h)}" x2="${GRAPH_W - GRAPH_PAD.right}" y2="${sy(h)}" stroke="${GRAPH_GREY}" stroke-width="1" stroke-dasharray="4 4"/>`);
    }
  }

  // Кривые. Разрыв (y:null) и вылет за окно рвут полилинию: гипербола — две
  // ветви, а не линия через ноль. Вторая функция — тот же цвет, тоньше и пунктиром.
  graph.plots.forEach((plot, idx) => {
    const segments = [];
    let current = [];
    for (const [x, y] of plot.points) {
      if (!inWin(y)) {
        if (current.length > 1) segments.push(current);
        current = [];
        continue;
      }
      current.push(`${sx(x).toFixed(1)},${sy(y).toFixed(1)}`);
    }
    if (current.length > 1) segments.push(current);
    const d = segments.map((seg) => "M" + seg.join(" L")).join(" ");
    const style = idx === 0
      ? `stroke="${GRAPH_ACCENT}" stroke-width="2.2"`
      : `stroke="${GRAPH_ACCENT}" stroke-width="1.4" stroke-dasharray="7 5"`;
    if (d) parts.push(`<path d="${d}" fill="none" ${style} stroke-linejoin="round" class="graph-line"/>`);
  });

  // Особые точки: нули — залитые кружки на оси, экстремумы — с белой серединой.
  for (const plot of graph.plots) {
    for (const z of plot.zeros) {
      if (z < xa || z > xb) continue;
      parts.push(`<circle cx="${sx(z)}" cy="${sy(0)}" r="3.5" fill="${GRAPH_ACCENT}" class="graph-zero"/>`);
      parts.push(`<text x="${sx(z)}" y="${sy(0) + 15}" font-size="11" fill="#444441" text-anchor="middle">${graphNumber(z)}</text>`);
    }
    for (const e of plot.extrema) {
      if (e.x < xa || e.x > xb || !inWin(e.y)) continue;
      parts.push(`<circle cx="${sx(e.x)}" cy="${sy(e.y)}" r="3.5" fill="#fff" stroke="${GRAPH_ACCENT}" stroke-width="2" class="graph-extremum"/>`);
      parts.push(`<text x="${sx(e.x)}" y="${sy(e.y) + (e.kind === "max" ? -8 : 16)}" font-size="11" fill="#444441" text-anchor="middle">(${graphNumber(e.x)}; ${graphNumber(e.y)})</text>`);
    }
  }

  // Пересечение двух функций — для системы это и есть ответ, выделяем сильнее.
  for (const [ix, iy] of graphIntersections(graph.plots)) {
    if (!inWin(iy)) continue;
    parts.push(`<circle cx="${sx(ix)}" cy="${sy(iy)}" r="4.5" fill="${GRAPH_ACCENT}" class="graph-intersection"/>`);
    parts.push(`<text x="${sx(ix)}" y="${sy(iy) - 9}" font-size="12" font-weight="500" fill="#04234F" text-anchor="middle">(${graphNumber(ix)}; ${graphNumber(iy)})</text>`);
  }

  return `<svg viewBox="0 0 ${GRAPH_W} ${GRAPH_H}" role="img" aria-label="График функции">${parts.join("")}</svg>`;
}

/** Заполняет карточку графика или прячет её, если графика нет (старый кэш, отказ бэкенда). */
// ---------- параметрические рисунки (№12, группа Б): кружки и числовой луч ----------
// Принцип графика: модель называет только ПАРАМЕТРЫ (числа из условия),
// рисует система детерминированным шаблоном. Верность рисунка = верность
// чисел, а числа сверяемы с условием — свободного рисования здесь нет.

function circlesSvg(v) {
  const total = Math.min(Math.max(1, Math.round(v.circlesTotal ?? 0)), 40);
  const crossed = Math.min(Math.max(0, Math.round(v.circlesCrossed ?? 0)), total);
  const group = v.circlesGroupSize ? Math.max(2, Math.round(v.circlesGroupSize)) : null;
  const perRow = 10, r = 9, gap = 26, gapGroup = 12;
  const cols = Math.min(total, perRow);
  const rows = Math.ceil(total / perRow);
  const extra = group ? Math.floor((cols - 1) / group) * gapGroup : 0;
  const w = cols * gap + extra + 8, h = rows * gap + 8;
  let out = "";
  for (let i = 0; i < total; i++) {
    const col = i % perRow, row = Math.floor(i / perRow);
    const gx = group ? Math.floor(col / group) * gapGroup : 0;
    const cx = 4 + r + col * gap + gx, cy = 4 + r + row * gap;
    const isCrossed = i >= total - crossed;
    out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${isCrossed ? "none" : "#185FA5"}" fill-opacity="${isCrossed ? 0 : 0.25}" stroke="#185FA5" stroke-width="1.5"/>`;
    if (isCrossed) out += `<path d="M${cx - r * 0.7} ${cy - r * 0.7} L${cx + r * 0.7} ${cy + r * 0.7} M${cx + r * 0.7} ${cy - r * 0.7} L${cx - r * 0.7} ${cy + r * 0.7}" stroke="#B54141" stroke-width="1.8"/>`;
  }
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px" role="img">${out}</svg>`;
}

function numberlineSvg(v) {
  const pts = (v.points ?? []).filter((p) => Number.isFinite(p.value)).slice(0, 8);
  if (!pts.length || !v.range) return "";
  let [a, b] = v.range;
  if (!(b > a)) { a = Math.min(...pts.map((p) => p.value)) - 1; b = Math.max(...pts.map((p) => p.value)) + 1; }
  const W = 320, H = 66, pad = 18, y = 40;
  const X = (val) => pad + ((val - a) / (b - a)) * (W - 2 * pad);
  let out = `<line x1="4" y1="${y}" x2="${W - 4}" y2="${y}" stroke="#5B5A54" stroke-width="1.5"/>` +
    `<path d="M${W - 10} ${y - 4} L${W - 4} ${y} L${W - 10} ${y + 4}" fill="none" stroke="#5B5A54" stroke-width="1.5"/>`;
  const step = graphNiceStep((b - a) / 6);
  for (let t = Math.ceil(a / step) * step; t <= b + 1e-9; t += step) {
    const x = X(t);
    out += `<line x1="${x}" y1="${y - 4}" x2="${x}" y2="${y + 4}" stroke="#8B8A84" stroke-width="1"/>` +
      `<text x="${x}" y="${y + 18}" font-size="10" text-anchor="middle" fill="#8B8A84">${Number(t.toFixed(6))}</text>`;
  }
  for (const p of pts) {
    const x = X(p.value);
    out += `<circle cx="${x}" cy="${y}" r="4" fill="#185FA5"/>` +
      `<text x="${x}" y="${y - 10}" font-size="11" text-anchor="middle" fill="#185FA5">${escapeHtml(p.label || String(p.value))}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px" role="img">${out}</svg>`;
}

function renderVisualCard(visual) {
  if (!visual || !visualCard) {
    if (visualCard) { visualCard.hidden = true; visualCard.innerHTML = ""; }
    return;
  }
  const svg = visual.kind === "circles" ? circlesSvg(visual) : numberlineSvg(visual);
  if (!svg) { visualCard.hidden = true; visualCard.innerHTML = ""; return; }
  const comment = visual.comment ? `<p class="graph-comment">${escapeHtml(visual.comment)}</p>` : "";
  visualCard.innerHTML = svg + comment;
  visualCard.hidden = false;
  renderMath(visualCard);
}

function renderGraphCard(graph) {
  if (!graph?.plots?.length) {
    graphCard.hidden = true;
    graphCard.innerHTML = "";
    return;
  }
  const comment = graph.comment
    ? `<p class="graph-comment">${escapeHtml(graph.comment)}</p>`
    : "";
  graphCard.innerHTML = graphSvg(graph) + comment;
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
  renderVisualCard(solution.visual);
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

function feedbackPayload(type, comment) {
  return {
    type,
    grade: state.grade,
    subject: state.subject,
    recognizedText: state.recognizedText,
    solutionSnapshot: type === "check" ? state.check : state.solution,
    userComment: comment,
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

async function sendFeedback(box, type) {
  const send = box.querySelector(".feedback-send");
  const status = box.querySelector(".feedback-status");
  const comment = box.querySelector(".feedback-text").value;

  status.hidden = true;
  setButtonBusy(send, true, "Отправляем…");
  try {
    await postJson("/api/feedback", feedbackPayload(type, comment), FEEDBACK_TIMEOUT_MS);
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

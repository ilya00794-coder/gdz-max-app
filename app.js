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

/** Скрипт Bridge грузится асинхронно, поэтому ждём появления window.WebApp. */
function waitForBridge(timeoutMs = 3000, stepMs = 50) {
  return new Promise((resolve) => {
    if (window.WebApp) return resolve(window.WebApp);
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (window.WebApp) {
        clearInterval(timer);
        resolve(window.WebApp);
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        resolve(null);
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
  const bridge = await waitForBridge();

  if (bridge) {
    max.mode = "max";
    // initData — подписанная строка запуска, её проверяет бэкенд. Доверять данным
    // из initDataUnsafe на клиенте нельзя, они только для отрисовки.
    max.initData = bridge.initData ?? null;
    max.user = bridge.initDataUnsafe?.user ?? null;
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
const SUBJECTS = ["Математика", "Русский язык", "Физика", "Химия", "Биология", "История", "Английский"];

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
const btnModeSolve = document.getElementById("btn-mode-solve");
const btnModeCheck = document.getElementById("btn-mode-check");

renderChips(gradeRow, GRADES.map((g) => `${g} класс`), (label, btn) => {
  state.grade = GRADES[[...gradeRow.children].indexOf(btn)];
  selectChip(gradeRow, btn);
  updateSetupCta();
});

renderChips(subjectRow, SUBJECTS, (label, btn) => {
  state.subject = label;
  selectChip(subjectRow, btn);
  updateSetupCta();
});

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
    ? "Сфотографируй своё решение в тетради"
    : "Сфотографируй задачу из учебника";
  document.querySelector(".capture-sub").textContent = check
    ? "Можно добавить несколько страниц"
    : "Можно добавить несколько снимков";
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

cropFrame.addEventListener("pointerdown", (e) => {
  if (!cropRect) return;
  const handle = e.target.closest(".crop-handle")?.dataset.handle;
  const insideBox = e.target === cropBox || e.target.closest(".crop-box");
  if (!handle && !insideBox) return;

  cropDrag = { handle: handle ?? null, startX: e.clientX, startY: e.clientY, start: { ...cropRect } };
  cropFrame.setPointerCapture(e.pointerId);
  e.preventDefault();
});

cropFrame.addEventListener("pointermove", (e) => {
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
});

const endCropDrag = () => { cropDrag = null; };
cropFrame.addEventListener("pointerup", endCropDrag);
cropFrame.addEventListener("pointercancel", endCropDrag);

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
    updateConfirmCta();
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
  setButtonBusy(btnSolve, true, check ? "Проверяем…" : "Распознаём…");
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
    setButtonBusy(btnSolve, false);
  }
}

function showResult(mode, result) {
  if (mode === "check") {
    state.check = result;
    renderCheck(result);
    showScreen("screen-check");
    return;
  }
  // Кладём ответ целиком: recognizedText, steps, finalAnswer, verification и всё остальное.
  state.solution = result;
  state.recognizedText = result.recognizedText ?? "";
  recognizedTextEl.value = state.recognizedText;
  updateConfirmCta();
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
const CHECK_TIMEOUT_MS = 90000;

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
    return "Сервер долго не отвечает. Попробуйте снова.";
  }
  if (status === null || status === undefined) {
    return "Нет связи с сервером. Проверьте интернет и попробуйте снова.";
  }
  if (status === 413) {
    return "Фото слишком большое. Снимите одну задачу крупнее или сожмите снимок.";
  }
  // 4xx бэкенд формулирует для ученика сам (422 «переснимите», 400 про формат файла) —
  // такой текст показываем как есть, он точнее любого общего.
  if (status < 500 && err?.serverMessage) {
    return err.serverMessage;
  }
  return "Что-то пошло не так на нашей стороне. Попробуйте ещё раз через минуту.";
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
const answerBlock = document.getElementById("answer-block");
const solutionTask = document.getElementById("solution-task");
const btnNewTask = document.getElementById("btn-new-task");
const btnReport = document.getElementById("btn-report");
const solutionScreen = document.getElementById("screen-solution");

/**
 * Строка проверки под ответом.
 * Данных о степени уверенности нет — только verified true/false, его и показываем.
 * Неверифицированное решение обязано выглядеть неверифицированным (см. правила проекта).
 */
function verificationRow(verification) {
  const verified = verification?.verified === true;
  const icon = verified
    ? `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
         <circle cx="12" cy="12" r="9" /><path d="m9 12 2 2 4-4" />
       </svg>`
    : `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" aria-hidden="true">
         <circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" />
       </svg>`;
  const text = verified ? "Ответ проверен вычислением" : "Решение не проверено автоматически";
  return `<p class="answer-verify" data-verified="${verified}">${icon}<span>${text}</span></p>`;
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
          <p class="step-text">${escapeHtml(step.content)}</p>
        </div>
      </li>`
    )
    .join("");
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

  // Расхождение вердиктов не замалчиваем: показываем оба, не выбирая победителя.
  if (result.verdictConflict) {
    checkConflict.innerHTML = `
      <div class="check-note" data-kind="conflict">
        <div>
          <strong>Наши проверки разошлись</strong>
          <ul>
            <li>Разбор по шагам: ${result.verdictConflict.stepByStepIsCorrect ? "верно" : "есть ошибка"}</li>
            <li>Сверка ответа вычислением: ${result.verdictConflict.symbolicVerified ? "верно" : "не совпадает"}</li>
          </ul>
          Пока расхождение не разобрано, доверять вердикту нельзя — лучше проверить работу с учителем.
        </div>
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
    checkAnswerCheck.innerHTML = `
      <div class="check-note">
        <div>Ответ проверить вычислением не получилось — сверка здесь неприменима.</div>
      </div>`;
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

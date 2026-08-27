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
  grade: null,
  subject: null,
  photos: [], // { file, dataUrl }
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
const btnToCapture = document.getElementById("btn-to-capture");

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
  btnToCapture.disabled = !(state.grade && state.subject) || bridgeBlocked;
}

btnToCapture.addEventListener("click", () => showScreen("screen-capture"));
document.getElementById("btn-back-setup").addEventListener("click", () => showScreen("screen-setup"));

// ---------- экран 2: capture ----------
const fileInput = document.getElementById("file-input");
const thumbRow = document.getElementById("thumb-row");
const btnSolve = document.getElementById("btn-solve");

fileInput.addEventListener("change", async (e) => {
  const files = [...e.target.files];
  for (const file of files) {
    const dataUrl = await fileToDataUrl(file);
    state.photos.push({ file, dataUrl });
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = dataUrl;
    thumbRow.appendChild(img);
  }
});

function fileToDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

document.getElementById("btn-back-capture").addEventListener("click", () => showScreen("screen-setup"));

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

  // Фото нет — это не ошибка, а сценарий «введу условие сам»: идём на confirm с пустым полем.
  // Подсказка живёт в placeholder, а не в value: иначе ученик отправил бы чужой пример.
  if (state.photos.length === 0) {
    state.solution = null;
    state.recognizedText = "";
    recognizedTextEl.value = "";
    updateConfirmCta();
    showScreen("screen-confirm");
    return;
  }

  setButtonBusy(btnSolve, true, "Распознаём…");
  try {
    // dataUrl уже в виде data:image/...;base64,... — vision.js принимает такой формат.
    const solution = await postSolve({
      imagesBase64: state.photos.map((p) => p.dataUrl),
      grade: state.grade,
      subject: state.subject,
    });

    // Кладём ответ целиком: recognizedText, steps, finalAnswer, verification и всё остальное.
    state.solution = solution;
    state.recognizedText = solution.recognizedText ?? "";
    recognizedTextEl.value = state.recognizedText;
    updateConfirmCta();
    showScreen("screen-confirm");
  } catch (err) {
    // 422 — «не разобрали фото» или «печатного условия не найдено»: остаёмся на съёмке.
    showCaptureError(err.message);
  } finally {
    setButtonBusy(btnSolve, false);
  }
});

// ---------- экран 3: confirm ----------
document.getElementById("btn-back-confirm")?.addEventListener("click", () => showScreen("screen-capture"));

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
    state.solution = await postSolve({
      text: currentText,
      grade: state.grade,
      subject: state.subject,
    });
    renderSolution(state.solution);
    showScreen("screen-solution");
  } catch {
    // Никакой подстановки готового решения: ученик должен узнать, что решения нет.
    showConfirmError("Не удалось получить решение, проверьте связь и попробуйте снова.");
  } finally {
    setButtonBusy(btnConfirm, false);
  }
});

// ---------- вызов backend ----------

/**
 * Голый запрос к /api/solve: ошибки НЕ маскирует, отдаёт текст ошибки от бэкенда.
 * Используется для распознавания фото — там подмена ошибки моком недопустима:
 * ученик должен узнать, что снимок не разобрали, а не получить решение чужой задачи.
 */
async function postSolve(payload) {
  const res = await fetch(`${BACKEND_URL}/api/solve`, {
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
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || `Бэкенд ответил ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
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

function renderSolution(solution) {
  // Краткое условие в шапке — чтобы было видно, что именно решаем.
  solutionTask.textContent = state.recognizedText || "";

  stepsList.innerHTML = "";
  solution.steps.forEach((step, i) => {
    const li = document.createElement("li");
    li.className = "step";
    li.innerHTML = `
      <span class="step-num">${i + 1}</span>
      <div class="step-body">
        <h2 class="step-title">${step.title}</h2>
        <p class="step-text">${step.content}</p>
      </div>
    `;
    stepsList.appendChild(li);
  });

  answerBlock.innerHTML = `
    <p class="answer-label">Ответ</p>
    <p class="answer-value">${solution.finalAnswer}</p>
    ${verificationRow(solution.verification)}
  `;

  // Формулы отрисовываем после того, как всё уже в DOM.
  renderMath(stepsList);
  renderMath(answerBlock);

  hideSheetNote();
  document.querySelector(".sheet-scroll").scrollTop = 0;
}

btnNewTask.addEventListener("click", () => showScreen("screen-capture"));

/** Пока это визуальная заглушка: приёма жалоб на бэкенде ещё нет, врать об отправке нельзя. */
function showSheetNote(text) {
  let el = document.getElementById("sheet-note");
  if (!el) {
    el = document.createElement("p");
    el.id = "sheet-note";
    el.className = "sheet-note";
    document.querySelector(".sheet-actions")?.insertAdjacentElement("beforebegin", el);
  }
  el.textContent = text;
  el.hidden = false;
}

function hideSheetNote() {
  const el = document.getElementById("sheet-note");
  if (el) el.hidden = true;
}

btnReport.addEventListener("click", () => {
  showSheetNote("Кнопка пока не отправляет сообщение — приём жалоб на ответ появится позже.");
});

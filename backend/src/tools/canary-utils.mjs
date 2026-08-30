// Утилиты канареек промпта. Главное — normalizeNotation: три ложных FAIL
// подряд случились из-за того, что тесты искали символ, а модель писала
// эквивалентную запись (∠ vs \angle, ° vs ^\circ, буквы в $...$).
// Сравнивать нужно смысл, а не символ — прогоняй ОБЕ стороны через эту
// нормализацию, прежде чем матчить.

export function normalizeNotation(text) {
  return String(text ?? "")
    .replace(/\\angle\s*/g, "∠")
    .replace(/\^\{?\\circ\}?/g, "°")
    .replace(/\\circ/g, "°")
    .replace(/\\cdot/g, "·")
    .replace(/\\times/g, "·")
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "$1/$2")
    .replace(/\\d?frac/g, "")
    .replace(/\\text\{([^{}]*)\}/g, "$1")
    .replace(/\\(perp|parallel)/g, (m, w) => (w === "perp" ? "⊥" : "∥"))
    .replace(/\\[a-zA-Z]+/g, " ")   // прочие команды — в пробел, чтобы не склеивать слова
    .replace(/[${}]/g, "")
    .replace(/\s+/g, " ");
}

// ---- кириллица и границы слов ----
//
// JS-\w и \b НЕ считают кириллицу словесной: /разбит\w+/ не берёт
// «разбитого», /\bили\b/ не находит « или ». Это дало ЧЕТЫРЕ ложных FAIL
// канареек и один настоящий прод-баг (parseCandidateAnswer, «или»/«и»).
// Класс закрыт: для слов используй эти помощники, а не \w и \b.

export function wordRegex(stem, flags = "i") {
  // «разбит» → берёт «разбит», «разбитого», «разбитым»; граница — не-буква.
  return new RegExp(`(?:^|[^а-яёa-z0-9_])${stem}[а-яё]*`, flags);
}

export function hasWord(text, stem) {
  return wordRegex(stem).test(String(text ?? ""));
}

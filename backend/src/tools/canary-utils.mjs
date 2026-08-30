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

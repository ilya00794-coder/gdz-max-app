// Инкрементальный разбор шагов из ПОТОКА структурированного JSON solver'а.
//
// Штатного события «закрылся элемент массива» в SDK нет, поэтому режем сами.
// Парсер — посимвольная машина состояний с JSON-честной обработкой строк
// (escape-последовательности, кавычки внутри, слэши LaTeX, переносы) —
// регэкспам тут не место: "content" c \" внутри или \\ на конце строки
// ломает любой наивный шаблон. Каждый закрытый объект шага прогоняется
// через JSON.parse — то есть наружу уходит только валидный JSON.
//
// Рассчитан на схему, где "steps" — ПЕРВОЕ поле верхнего уровня (см.
// SolutionSchema). Если модель вернёт поля в другом порядке, парсер просто
// не выдаст ни одного шага до конца — это деградация до нестримингового
// поведения, не ошибка.

export class StepStreamParser {
  constructor() {
    this.buf = "";
    this.pos = 0;
    this.state = "seek"; // seek → array → done
    this.inString = false;
    this.escape = false;
    this.depth = 0;
    this.objStart = -1;
  }

  /** Скармливает очередной кусок текста; возвращает НОВЫЕ закрытые шаги. */
  feed(chunk) {
    this.buf += chunk;
    const out = [];
    if (this.state === "seek") {
      const key = this.buf.indexOf('"steps"');
      if (key === -1) return out;
      const bracket = this.buf.indexOf("[", key);
      if (bracket === -1) return out;
      this.state = "array";
      this.pos = bracket + 1;
    }
    if (this.state !== "array") return out;
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos];
      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (c === "\\") this.escape = true;
        else if (c === '"') this.inString = false;
      } else if (c === '"') {
        this.inString = true;
      } else if (c === "{") {
        if (this.depth === 0) this.objStart = this.pos;
        this.depth++;
      } else if (c === "}") {
        this.depth--;
        if (this.depth === 0 && this.objStart !== -1) {
          try {
            out.push(JSON.parse(this.buf.slice(this.objStart, this.pos + 1)));
          } catch {
            // Полшага не отдаём никогда: не распарсилось — молча ждём финала.
          }
          this.objStart = -1;
        }
      } else if (c === "]" && this.depth === 0) {
        this.state = "done";
        this.pos++;
        break;
      }
      this.pos++;
    }
    return out;
  }
}

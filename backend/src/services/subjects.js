// Какие предметы изучаются в каждом классе — данные федеральных учебных планов
// (src/data/curriculum/subjects.json, источники в SOURCES.md).
//
// Два потребителя:
//  - GET /api/subjects?grade=N — фронт строит чипы выбора предмета;
//  - валидация пары (класс, предмет) в solve-роуте — защита от кривого клиента,
//    чтобы «3 класс + физика» не уходил молча в solver.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { grades, computable } = require("../data/curriculum/subjects.json");

/** Та же нормализация, что в curriculum.js: регистр, пробелы, ё→е. */
function normalize(subject) {
  return String(subject || "").trim().toLowerCase().replace(/ё/g, "е");
}

// Синонимы, которые валидация принимает сверх списков плана. Нужны, пока фронт
// шлёт старые ярлыки, и для агрегатных названий:
//  - «английский» — старый чип, в плане предмет «Английский язык»;
//  - «математика» в 7–11 — по плану её нет (алгебра/геометрия/вероятность),
//    но как агрегат она легитимна: curriculum.js разворачивает её во все курсы.
const ALIASES = new Map([
  ["английский", "английский язык"],
]);
const MATH_COURSES = new Set([
  "алгебра",
  "алгебра и начала математического анализа",
  "геометрия",
  "вероятность и статистика",
]);

/**
 * Список предметов класса, как в учебном плане (для чипов фронта).
 * @returns {string[]|null} null — если класс вне 1–11
 */
export function getSubjectsForGrade(grade) {
  return grades[String(grade)] ?? null;
}

/** Допустима ли пара (класс, предмет) — с учётом синонимов старого фронта. */
export function isSubjectAllowedForGrade(grade, subject) {
  const list = getSubjectsForGrade(grade);
  if (!list) return false;

  const normalizedList = new Set(list.map(normalize));
  let wanted = normalize(subject);
  wanted = ALIASES.get(wanted) ?? wanted;

  if (normalizedList.has(wanted)) return true;
  if (wanted === "математика") {
    return [...MATH_COURSES].some((course) => normalizedList.has(course));
  }
  return false;
}

// Нормализованная карта вычислимости: ключи — как normalize() выше.
const COMPUTABLE_BY_SUBJECT = new Map(
  Object.entries(computable ?? {}).map(([name, flag]) => [normalize(name), Boolean(flag)])
);

/**
 * Проверяется ли финальный ответ предмета символьно (SymPy).
 * ЕДИНСТВЕННАЯ точка входа для прода (verify.js) и стенда — флаг живёт
 * в subjects.json при данных учебного плана, не в коде.
 * Предмет без записи в карте — ошибка конфигурации, а не «false»:
 * молчаливое false уже прятало алгебру 10–11 от верификации.
 * Полнота карты для всех предметов плана проверяется на старте сервера.
 */
export function isComputableSubject(subject) {
  const flag = COMPUTABLE_BY_SUBJECT.get(normalize(subject));
  if (flag === undefined) {
    throw new Error(
      `предмет «${subject}» отсутствует в карте computable (src/data/curriculum/subjects.json) — добавь запись true/false`
    );
  }
  return flag;
}

/** Все предметы учебного плана (объединение по классам) — для стартовых проверок полноты. */
export function allPlanSubjects() {
  const seen = new Set();
  for (const list of Object.values(grades)) for (const s of list) seen.add(s);
  return [...seen];
}

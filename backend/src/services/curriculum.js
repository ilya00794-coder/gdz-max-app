// Справочный слой школьной программы: какие способы решения ученик уже прошёл
// к конкретному моменту обучения.
//
// Источник данных — ТОЛЬКО официальные федеральные рабочие программы (ФРП) из реестра
// Минпросвещения (edsoo.ru). Тексты учебников и чужих решебников здесь не используются:
// хранятся не формулировки заданий и не решения, а перечень изученных МЕТОДОВ.
// Точные ссылки на документы — в backend/src/data/curriculum/SOURCES.md.
//
// Зачем это solver.js: шестикласснику нельзя объяснять решение через дискриминант,
// даже если так короче — он его ещё не проходил. Функция ниже даёт белый список методов.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mathCurriculum = require("../data/curriculum/math.json");

/** Курсы внутри предметной области «математика», как они разделены в ФРП. */
const COURSE = {
  MATH: "математика", // 1–6 классы, единый курс
  ALGEBRA: "алгебра",
  GEOMETRY: "геометрия",
  PROBABILITY: "вероятность и статистика",
};

/**
 * Какие курсы включать для запрошенного предмета.
 * Курс «математика» (1–6) входит везде: это база, на которой стоят все остальные.
 */
const SUBJECT_TO_COURSES = {
  "математика": [COURSE.MATH, COURSE.ALGEBRA, COURSE.GEOMETRY, COURSE.PROBABILITY],
  "алгебра": [COURSE.MATH, COURSE.ALGEBRA],
  "алгебра и начала математического анализа": [COURSE.MATH, COURSE.ALGEBRA],
  "геометрия": [COURSE.MATH, COURSE.GEOMETRY],
  "стереометрия": [COURSE.MATH, COURSE.GEOMETRY],
  "вероятность и статистика": [COURSE.MATH, COURSE.PROBABILITY],
  "теория вероятностей": [COURSE.MATH, COURSE.PROBABILITY],
};

export const SUPPORTED_SUBJECTS = Object.keys(SUBJECT_TO_COURSES);

const MIN_GRADE = 1;
const MAX_GRADE = 11;

function normalizeSubject(subject) {
  return String(subject || "").trim().toLowerCase().replace(/ё/g, "е");
}

/** Ключи словаря тоже нормализуем, чтобы «Алгебра» и «алгебра» работали одинаково. */
const NORMALIZED_SUBJECTS = new Map(
  Object.entries(SUBJECT_TO_COURSES).map(([key, courses]) => [normalizeSubject(key), courses])
);

export function isSubjectSupported(subject) {
  return NORMALIZED_SUBJECTS.has(normalizeSubject(subject));
}

/**
 * Записи программы, пройденные к указанному моменту (кумулятивно).
 * Кумулятивность: все предыдущие классы целиком + текущий класс по указанную четверть включительно.
 *
 * @param {object} params
 * @param {number} params.grade - класс ученика, 1–11
 * @param {string} params.subject - предмет (см. SUPPORTED_SUBJECTS)
 * @param {number} [params.quarter=4] - четверть, 1–4. По умолчанию 4 — «за весь учебный год».
 * @returns {{grade:number, quarter:number, course:string, topic:string, methods:string[], source:string}[]}
 */
export function getCurriculumSlice({ grade, subject, quarter = 4 }) {
  if (!Number.isInteger(grade) || grade < MIN_GRADE || grade > MAX_GRADE) {
    throw new Error(`Класс должен быть целым числом от ${MIN_GRADE} до ${MAX_GRADE}, получено: ${grade}`);
  }
  if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    throw new Error(`Четверть должна быть целым числом от 1 до 4, получено: ${quarter}`);
  }

  const courses = NORMALIZED_SUBJECTS.get(normalizeSubject(subject));
  if (!courses) {
    throw new Error(
      `Предмет «${subject}» не поддерживается. Доступны: ${SUPPORTED_SUBJECTS.join(", ")}`
    );
  }

  return mathCurriculum
    .filter((entry) => courses.includes(entry.course))
    .filter((entry) => entry.grade < grade || (entry.grade === grade && entry.quarter <= quarter))
    .sort((a, b) => a.grade - b.grade || a.quarter - b.quarter || a.course.localeCompare(b.course));
}

/**
 * Плоский список методов решения, уже пройденных к этому моменту, без дублей.
 * Порядок — хронологический (от 1 класса к текущей четверти).
 *
 * @param {object} params - те же, что у getCurriculumSlice
 * @returns {string[]}
 */
export function getAllowedMethods({ grade, subject, quarter = 4 }) {
  const seen = new Set();
  for (const entry of getCurriculumSlice({ grade, subject, quarter })) {
    for (const method of entry.methods) seen.add(method);
  }
  return [...seen];
}

/**
 * Темы, изученные к этому моменту — короткая сводка для промпта solver.js,
 * когда полный список методов слишком длинный.
 *
 * @param {object} params - те же, что у getCurriculumSlice
 * @returns {{grade:number, quarter:number, course:string, topic:string}[]}
 */
export function getStudiedTopics({ grade, subject, quarter = 4 }) {
  return getCurriculumSlice({ grade, subject, quarter }).map(({ grade: g, quarter: q, course, topic }) => ({
    grade: g,
    quarter: q,
    course,
    topic,
  }));
}

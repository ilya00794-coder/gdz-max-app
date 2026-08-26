"""Символьная проверка ответа через SymPy.

Запускается из verify.js отдельным процессом. Получает JSON на stdin, отдаёт JSON на stdout.

Вход:  {"expression": "solve(x**8 - (4*x-5)**4, x)", "candidates": ["1", "-5"]}
Выход: {"ok": true, "verified": true, "solutions": [...], "realSolutions": [...], ...}

Безопасность: выражение приходит от LLM, поэтому не выполняется как есть.
Сначала разбираем его в AST и пропускаем только математические узлы и функции
из белого списка; всё остальное (импорты, атрибуты, индексы, строки, lambda)
отвергается ДО вычисления. Вычисление идёт без builtins.
"""

import ast
import json
import sys

import sympy


# Функции, которые разрешено вызывать в выражении.
ALLOWED_CALLS = {
    "solve": sympy.solve,
    "solveset": sympy.solveset,
    "Eq": sympy.Eq,
    "sqrt": sympy.sqrt,
    "cbrt": sympy.cbrt,
    "root": sympy.root,
    "Abs": sympy.Abs,
    "exp": sympy.exp,
    "log": sympy.log,
    "ln": sympy.log,
    "sin": sympy.sin,
    "cos": sympy.cos,
    "tan": sympy.tan,
    "cot": sympy.cot,
    "asin": sympy.asin,
    "acos": sympy.acos,
    "atan": sympy.atan,
    "factorial": sympy.factorial,
    "binomial": sympy.binomial,
    "Rational": sympy.Rational,
    "simplify": sympy.simplify,
    "expand": sympy.expand,
    "factor": sympy.factor,
    "diff": sympy.diff,
    "integrate": sympy.integrate,
    "limit": sympy.limit,
}

# Константы, разрешённые как имена.
ALLOWED_CONSTANTS = {
    "pi": sympy.pi,
    "E": sympy.E,
    "oo": sympy.oo,
    "I": sympy.I,
}

# Разрешённые типы узлов AST. Всё, чего здесь нет, — отказ.
ALLOWED_NODES = (
    ast.Expression,
    ast.Call,
    ast.Name,
    ast.Load,
    ast.Constant,
    ast.BinOp,
    ast.UnaryOp,
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.Div,
    ast.FloorDiv,
    ast.Mod,
    ast.Pow,
    ast.USub,
    ast.UAdd,
    ast.Tuple,
    ast.List,
    ast.keyword,
)

MAX_EXPRESSION_LENGTH = 2000


class Rejected(Exception):
    """Выражение не прошло проверку белого списка."""


class EqualityRewriter(ast.NodeTransformer):
    """Превращает сравнение `a == b` в вызов Eq(a, b).

    Модель записывает уравнение как `solve(2*x + 8 == 20, x)`. В Python такое сравнение
    двух объектов SymPy вернуло бы обычный bool, а не уравнение, поэтому переписываем узел
    в явный Eq(). Любые другие операторы сравнения (<, >, !=) отвергаются.
    """

    def visit_Compare(self, node):  # noqa: N802 — имя задано ast
        self.generic_visit(node)
        if len(node.ops) != 1 or not isinstance(node.ops[0], ast.Eq):
            raise Rejected("в выражении допустимо только равенство")
        return ast.Call(
            func=ast.Name(id="Eq", ctx=ast.Load()),
            args=[node.left, node.comparators[0]],
            keywords=[],
        )


def build_namespace(tree):
    """Проверяет AST и собирает окружение: разрешённые функции + символы переменных."""
    namespace = dict(ALLOWED_CONSTANTS)

    for node in ast.walk(tree):
        if not isinstance(node, ALLOWED_NODES):
            raise Rejected(f"запрещённая конструкция: {type(node).__name__}")

        if isinstance(node, ast.Constant) and not isinstance(node.value, (int, float)):
            raise Rejected("разрешены только числовые константы")

        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name):
                raise Rejected("вызывать можно только функции из белого списка по имени")
            if node.func.id not in ALLOWED_CALLS:
                raise Rejected(f"функция вне белого списка: {node.func.id}")

        if isinstance(node, ast.Name):
            name = node.id
            if name.startswith("_"):
                raise Rejected(f"недопустимое имя: {name}")
            if name in ALLOWED_CALLS:
                namespace[name] = ALLOWED_CALLS[name]
            elif name in ALLOWED_CONSTANTS:
                continue
            elif len(name) <= 3 and name.isalnum():
                # Одно-трёхбуквенное имя считаем переменной: x, y, x1, a, b.
                namespace[name] = sympy.Symbol(name)
            else:
                raise Rejected(f"неизвестное имя: {name}")

    return namespace


def evaluate(expression):
    """Разбирает и вычисляет выражение в изолированном окружении."""
    if len(expression) > MAX_EXPRESSION_LENGTH:
        raise Rejected("выражение слишком длинное")

    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as err:
        raise Rejected(f"синтаксическая ошибка: {err.msg}")

    # Сначала переписываем равенства в Eq(), потом проверяем белым списком:
    # так в проверку попадает уже то дерево, которое реально будет вычисляться.
    tree = ast.fix_missing_locations(EqualityRewriter().visit(tree))

    namespace = build_namespace(tree)
    compiled = compile(tree, "<verify>", "eval")
    return eval(compiled, {"__builtins__": {}}, namespace)  # noqa: S307 — AST уже отфильтрован


def to_solution_list(result):
    """Приводит результат к списку решений, доразрешая уравнение, если это ещё не решения."""
    if isinstance(result, dict):
        return list(result.values())

    if isinstance(result, (list, tuple, set, frozenset)):
        flat = []
        for item in result:
            # solve() для систем возвращает список словарей или кортежей.
            if isinstance(item, dict):
                flat.extend(item.values())
            elif isinstance(item, (list, tuple)):
                flat.extend(item)
            else:
                flat.append(item)
        return flat

    if isinstance(result, sympy.sets.sets.Set):
        if result.is_FiniteSet:
            return list(result)
        raise Rejected("бесконечное множество решений — символьная сверка не применима")

    # Пришло само уравнение или выражение — решаем его сами.
    if isinstance(result, sympy.Basic):
        symbols = sorted(result.free_symbols, key=lambda s: s.name)
        if not symbols:
            # Числовой результат: это и есть ответ.
            return [result]
        if len(symbols) > 1:
            raise Rejected("несколько переменных — символьная сверка не применима")
        return sympy.solve(result, symbols[0])

    raise Rejected("непонятный результат вычисления")


def is_real(value):
    """Действительное ли решение. Школьный ответ по умолчанию вещественный."""
    simplified = sympy.simplify(value)
    return simplified.is_real is True


def same_value(a, b):
    """Совпадают ли два значения символьно, а не по строковому виду."""
    try:
        return sympy.simplify(a - b) == 0
    except (TypeError, ValueError):
        return False


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError) as err:
        print(json.dumps({"ok": False, "reason": f"некорректный вход: {err}"}))
        return

    expression = payload.get("expression") or ""
    raw_candidates = payload.get("candidates") or []

    try:
        result = evaluate(expression)
        solutions = to_solution_list(result)
    except Rejected as err:
        print(json.dumps({"ok": False, "reason": str(err)}))
        return
    except Exception as err:  # SymPy может упасть на экзотическом вводе
        print(json.dumps({"ok": False, "reason": f"sympy не справился: {type(err).__name__}: {err}"}))
        return

    try:
        candidates = [evaluate(c) for c in raw_candidates]
    except Rejected as err:
        print(json.dumps({"ok": False, "reason": f"не разобран ответ ученика: {err}"}))
        return
    except Exception as err:
        print(json.dumps({"ok": False, "reason": f"не разобран ответ ученика: {type(err).__name__}: {err}"}))
        return

    real_solutions = [s for s in solutions if is_real(s)]

    # Сверяем с действительными корнями: комплексные в школьный ответ не выносятся.
    reference = real_solutions
    matched = []
    missing = []
    for ref in reference:
        if any(same_value(ref, cand) for cand in candidates):
            matched.append(ref)
        else:
            missing.append(ref)

    extra = [c for c in candidates if not any(same_value(c, ref) for ref in reference)]

    verified = not missing and not extra and len(reference) == len(matched)

    print(json.dumps({
        "ok": True,
        "verified": verified,
        "solutions": [str(s) for s in solutions],
        "realSolutions": [str(s) for s in real_solutions],
        "candidates": [str(c) for c in candidates],
        "missing": [str(s) for s in missing],
        "extra": [str(c) for c in extra],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()

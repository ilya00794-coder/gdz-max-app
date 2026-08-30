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
import re
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

# Константы, разрешённые как имена. Только pi: у него нет школьного конкурента.
# I (сила тока), E (энергия), oo — убраны: преднасев затенял школьные переменные
# (solve(Eq(I, 12/4), I) молча возвращал пусто — I был мнимой единицей).
# Экспонента доступна через exp().
ALLOWED_CONSTANTS = {
    "pi": sympy.pi,
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
            # Внимание: bool — подкласс int, поэтому True/False проходят эту
            # проверку (например, keyword-аргумент dict=True). Установлено
            # живой пробой; вреда не выявлено — sympy трактует их как 1/0,
            # а вызовы всё равно ограничены белым списком.
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
            elif re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", name):
                # Имя из латиницы и цифр, не занятое константой или функцией, —
                # переменная. Лимита длины нет НАМЕРЕННО: он резал школьные
                # alpha/beta/gamma/theta/omega, и класс закрыт правилом, а не
                # списком. Защита — белый список узлов AST и вызовов, не длина.
                namespace[name] = sympy.Symbol(name)
            else:
                raise Rejected(f"неизвестное имя: {name}")

    return namespace


class NumbersToRational(ast.NodeTransformer):
    """Каждая числовая константа → sympy.Rational ДО вычисления.

    Корень float-класса: python-eval считает 36/4 и 0.002 флоатами раньше,
    чем их увидит SymPy, и сравнение Float/Integer капризничает. Мы латали
    это текстовыми обёртками в трёх местах (misread, инвариант any,
    Rational-запятая) — четвёртое всплытие (голые списки [36/4, ...])
    закрыло класс здесь, на уровне узлов. Строковый аргумент для float —
    Rational("2.5") представляет конечную десятичную точно; bool не трогаем
    (подкласс int, см. комментарий в фильтре констант).
    Применяется ПОСЛЕ проверки белым списком: строковая константа внутри
    Rational(...) — артефакт трансформации, а не вход пользователя.
    """

    def visit_Constant(self, node):  # noqa: N802 — имя задано ast
        if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
            return node
        arg = ast.Constant(value=node.value if isinstance(node.value, int) else repr(node.value))
        return ast.Call(func=ast.Name(id="Rational", ctx=ast.Load()), args=[arg], keywords=[])


def is_literal_expression(expression):
    """Выражение — одна числовая константа (возможно с минусом)?

    Такая «формализация» не независима: она не строит ответ из условия,
    а подставляет готовый. Честных формализаций-литералов не бывает
    (в 160 дампах — ноль), ложные срабатывания исключены по построению.
    """
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError:
        return False
    node = tree.body
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        node = node.operand
    return isinstance(node, ast.Constant) and isinstance(node.value, (int, float))


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
    # Числа в Rational — после белого списка (см. NumbersToRational).
    namespace.setdefault("Rational", sympy.Rational)
    tree = ast.fix_missing_locations(NumbersToRational().visit(tree))
    compiled = compile(tree, "<verify>", "eval")
    return eval(compiled, {"__builtins__": {}}, namespace)  # noqa: S307 — AST уже отфильтрован


def to_solution_list(result):
    """Приводит результат к списку решений, доразрешая уравнение, если это ещё не решения.

    Возвращает (решения, from_solver): from_solver=True — результат имеет
    семантику НАБОРА РЕШЕНИЙ (solve/solveset или уравнение, которое мы сами
    решили); False — это скалярное ЗНАЧЕНИЕ выражения. Различие критично для
    пустого ответа: «решений нет» осмысленно только против набора решений.
    """
    # Чистая арифметика ("128 + 236") вычисляется питоном в обычный int/float,
    # а не в sympy-объект — без этой ветки она падала в "непонятный результат",
    # и вся арифметика началки оставалась без верификации.
    if isinstance(result, (int, float)):
        return [sympy.S(result)], False

    if isinstance(result, dict):
        return list(result.values()), True

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
        return flat, True

    if isinstance(result, sympy.sets.sets.Set):
        if result.is_FiniteSet:
            return list(result), True
        raise Rejected("бесконечное множество решений — символьная сверка не применима")

    # Пришло само уравнение или выражение — решаем его сами.
    if isinstance(result, sympy.Basic):
        symbols = sorted(result.free_symbols, key=lambda s: s.name)
        if not symbols:
            # Числовой результат: это и есть ответ.
            return [result], False
        if len(symbols) > 1:
            raise Rejected("несколько переменных — символьная сверка не применима")
        return sympy.solve(result, symbols[0]), True

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


PLOT_POINTS = 201
PLOT_Y_LIMIT = 1e9  # |y| больше этого для рисунка бессмысленен — точка разрыва


def _plot_float(value):
    """Число для JSON-точки: конечный float или None (разрыв/не определено)."""
    import math
    try:
        c = complex(sympy.N(value))
    except Exception:
        return None
    if abs(c.imag) > 1e-9 or not math.isfinite(c.real) or abs(c.real) > PLOT_Y_LIMIT:
        return None
    return round(c.real, 6)


def run_plot(payload):
    """Режим mode=plot: точки и особые точки функции одним вызовом.

    Точки считаются через .subs(), а НЕ через lambdify — сознательно:
    lambdify — это кодогенерация с eval внутри SymPy. Выражение к этому
    моменту уже прошло AST-белый список, но расширять поверхность атаки
    кодогенерацией ради скорости незачем: 201 подстановка в школьную
    функцию укладывается в доли секунды. Если когда-нибудь станет медленно —
    менять на lambdify только вместе с пересмотром модели угроз.

    Существующий путь верификации не задет: сюда попадаем только при
    payload["mode"] == "plot".
    """
    expression = payload.get("expression") or ""
    x_range = payload.get("xRange") or [-10, 10]

    if (
        not isinstance(x_range, (list, tuple))
        or len(x_range) != 2
        or not all(isinstance(v, (int, float)) for v in x_range)
        or not x_range[0] < x_range[1]
    ):
        return {"ok": False, "reason": "xRange должен быть парой чисел [a, b], a < b"}

    expr = sympy.S(evaluate(expression))  # тот же AST-фильтр, что у верификации
    symbols = sorted(expr.free_symbols, key=lambda s: s.name)
    if len(symbols) > 1:
        return {"ok": False, "reason": "график строится по функции одной переменной"}
    x = symbols[0] if symbols else sympy.Symbol("x")

    warnings = []
    a, b = float(x_range[0]), float(x_range[1])

    points = []
    for i in range(PLOT_POINTS):
        xi = a + (b - a) * i / (PLOT_POINTS - 1)
        try:
            yi = _plot_float(expr.subs(x, sympy.Float(xi)))
        except Exception:
            yi = None
        points.append([round(xi, 6), yi])

    zeros = []
    try:
        for z in sympy.solve(sympy.Eq(expr, 0), x):
            zf = _plot_float(z)
            if zf is not None and sympy.simplify(z).is_real:
                zeros.append(zf)
    except Exception as err:
        warnings.append(f"нули не найдены: {type(err).__name__}")

    extrema = []
    try:
        derivative = sympy.diff(expr, x)
        for c in sympy.solve(sympy.Eq(derivative, 0), x):
            if sympy.simplify(c).is_real is not True:
                continue
            cx, cy = _plot_float(c), _plot_float(expr.subs(x, c))
            if cx is None or cy is None:
                continue
            kind = "unknown"
            try:
                second = sympy.diff(derivative, x).subs(x, c)
                if second.is_positive:
                    kind = "min"
                elif second.is_negative:
                    kind = "max"
            except Exception:
                pass
            extrema.append({"x": cx, "y": cy, "kind": kind})
    except Exception as err:
        warnings.append(f"экстремумы не найдены: {type(err).__name__}")

    vertical = []
    try:
        denominator = sympy.denom(sympy.together(expr))
        if denominator.free_symbols:
            for c in sympy.solve(sympy.Eq(denominator, 0), x):
                if sympy.simplify(c).is_real is not True:
                    continue
                # Кандидат — только если функция там действительно уходит в бесконечность.
                side = sympy.limit(expr, x, c, "+")
                if side in (sympy.oo, -sympy.oo, sympy.zoo):
                    cf = _plot_float(c)
                    if cf is not None:
                        vertical.append(cf)
    except Exception as err:
        warnings.append(f"вертикальные асимптоты не найдены: {type(err).__name__}")

    horizontal = []
    try:
        for direction in (sympy.oo, -sympy.oo):
            lim = sympy.limit(expr, x, direction)
            lf = _plot_float(lim)
            if lf is not None and lf not in horizontal:
                horizontal.append(lf)
    except Exception as err:
        warnings.append(f"горизонтальные асимптоты не найдены: {type(err).__name__}")

    return {
        "ok": True,
        "expression": str(expr),
        "xRange": [a, b],
        "points": points,
        "zeros": zeros,
        "extrema": extrema,
        "asymptotes": {"vertical": vertical, "horizontal": horizontal},
        "warnings": warnings,
    }


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError) as err:
        print(json.dumps({"ok": False, "reason": f"некорректный вход: {err}"}))
        return

    if payload.get("mode") == "plot":
        try:
            print(json.dumps(run_plot(payload), ensure_ascii=False))
        except Rejected as err:
            print(json.dumps({"ok": False, "reason": str(err)}, ensure_ascii=False))
        except Exception as err:  # график — усиление, а не условие: любой сбой = ok:false
            print(json.dumps({"ok": False, "reason": f"{type(err).__name__}: {err}"}, ensure_ascii=False))
        return

    expression = payload.get("expression") or ""
    raw_candidates = payload.get("candidates") or []

    if is_literal_expression(expression):
        print(json.dumps({
            "ok": False,
            "reason": "формализация не независима: выражение — готовое число, а не соотношение из условия",
        }, ensure_ascii=False))
        return

    try:
        result = evaluate(expression)

        if isinstance(result, (bool, sympy.logic.boolalg.BooleanAtom)):
            # Схлопнутая Eq без переменных: формализация — утверждение, а не задача.
            # Ложное утверждение — модель формализовала неверное равенство: это
            # дефект решателя, различаем его в причине отдельно от безобидного True.
            if bool(result):
                reason = "формализация — истинное числовое утверждение, а не задача"
            else:
                reason = "формализация — ЛОЖНОЕ числовое утверждение (дефект решателя)"
            print(json.dumps({"ok": False, "reason": reason}, ensure_ascii=False))
            return

        solutions, from_solver = to_solution_list(result)
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

    if not candidates and not from_solver:
        # «Решений нет» осмысленно только против решения уравнения; сверять
        # пустоту со скалярным значением — ложное verified даром.
        print(json.dumps({"ok": False, "reason": "пустой ответ можно сверять только с решением уравнения, а формализация даёт значение"}, ensure_ascii=False))
        return

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

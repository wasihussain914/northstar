"""Deterministic step checking with SymPy.

Claude transcribes the handwriting; this module decides whether each step
follows from the one before it. A verdict is one of:

    valid    - the step is mathematically equivalent to the previous one
    invalid  - it is not (a wrong turn)
    caution  - it keeps every solution but adds extra ones (e.g. squaring)
    unknown  - SymPy couldn't decide; the caller falls back to Claude's judgment

Algebra, trig, and precalculus stay in this file. Calculus, differential
equations, linear algebra, and discrete math are dispatched to `domains`
when the problem's syntax (or an explicit task) says so.

Inputs are strings written by a model reading user handwriting, so they are
untrusted: `parse_statement` whitelists characters and identifiers before
anything reaches sympy's parser (which uses eval).
"""

from __future__ import annotations

import random
import re
import string
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

import sympy as sp
from sympy.parsing.sympy_parser import (
    convert_xor,
    implicit_multiplication_application,
    parse_expr,
    standard_transformations,
)

Verdict = Literal["valid", "invalid", "caution", "unknown"]

_TRANSFORMS = standard_transformations + (implicit_multiplication_application, convert_xor)


def _diff(expr, *vars):
    return sp.Derivative(expr, *vars)


def _integrate(expr, var, a=None, b=None):
    if a is None:
        return sp.Integral(expr, var)
    return sp.Integral(expr, (var, a, b))


def _limit(expr, var, point):
    return sp.Limit(expr, var, point, dir="+-")


def _limleft(expr, var, point):
    return sp.Limit(expr, var, point, dir="-")


def _limright(expr, var, point):
    return sp.Limit(expr, var, point, dir="+")


def _summation(expr, var, a, b):
    return sp.Sum(expr, (var, a, b))


def _as_matrix(m):
    if isinstance(m, sp.MatrixBase):
        return m
    return sp.Matrix(m)


def _det(m):
    return sp.Determinant(_as_matrix(m))


def _inv(m):
    return sp.Inverse(_as_matrix(m))


def _grad(expr, *vars):
    return sp.Matrix([sp.diff(expr, v) for v in vars])


def _modinv(a, m):
    return sp.Integer(sp.mod_inverse(a, m))


_FUNCS = {
    "sqrt": sp.sqrt,
    "Abs": sp.Abs,
    "abs": sp.Abs,
    "log": sp.log,
    "ln": sp.log,
    "exp": sp.exp,
    "sin": sp.sin,
    "cos": sp.cos,
    "tan": sp.tan,
    "asin": sp.asin,
    "acos": sp.acos,
    "atan": sp.atan,
    "arcsin": sp.asin,
    "arccos": sp.acos,
    "arctan": sp.atan,
    "sec": sp.sec,
    "csc": sp.csc,
    "cot": sp.cot,
    "sinh": sp.sinh,
    "cosh": sp.cosh,
    "tanh": sp.tanh,
    "pi": sp.pi,
    "E": sp.E,
    "oo": sp.oo,
    "inf": sp.oo,
    "factorial": sp.factorial,
    "binomial": sp.binomial,
    "ceiling": sp.ceiling,
    "floor": sp.floor,
    "gcd": sp.gcd,
    "Mod": sp.Mod,
    "mod": sp.Mod,
    "modinv": _modinv,
    "diff": _diff,
    "integrate": _integrate,
    "limit": _limit,
    "limleft": _limleft,
    "limright": _limright,
    "summation": _summation,
    "Matrix": sp.Matrix,
    "det": _det,
    "inv": _inv,
    "grad": _grad,
}
# Every single letter is a real-valued variable, so names like N, S, Q or I
# never resolve to sympy objects.
_SYMBOLS = {c: sp.Symbol(c, real=True) for c in string.ascii_letters if c != "E"}
_LOCALS = {**_SYMBOLS, **_FUNCS}

_ALLOWED_CHARS = re.compile(r"^[0-9A-Za-z+\-*/^().,=<>!%\[\]; ]+$")
_IDENT = re.compile(r"[A-Za-z]+")
_BANNED = re.compile(r"__|\b(for|lambda|import|exec|eval|open|class|def|while|yield|return|global)\b")
_REL_SPLIT = re.compile(r"(<=|>=|!=|<|>|=)")
_REL_CLASS = {"<": sp.StrictLessThan, ">": sp.StrictGreaterThan, "<=": sp.LessThan, ">=": sp.GreaterThan}

_UNICODE = {
    "−": "-", "–": "-", "·": "*", "×": "*", "÷": "/", "√": "sqrt",
    "≤": "<=", "≥": ">=", "≠": "!=", "π": "pi", "²": "^2", "³": "^3",
    "∞": "oo",
}


class ParseError(ValueError):
    pass


@dataclass(frozen=True)
class Statement:
    """One parsed line of work."""

    kind: Literal["eq", "ineq", "expr", "matrix"]
    lhs: sp.Basic
    rhs: sp.Expr | None = None
    rel: str = "="

    @property
    def free(self) -> set[sp.Symbol]:
        syms = set(self.lhs.free_symbols)
        if self.rhs is not None:
            syms |= self.rhs.free_symbols
        return syms

    def relational(self) -> sp.Basic:
        if self.kind == "eq":
            return sp.Eq(self.lhs, self.rhs)
        return _REL_CLASS[self.rel](self.lhs, self.rhs)


def _clean(text: str) -> str:
    for k, v in _UNICODE.items():
        text = text.replace(k, v)
    return text.replace("==", "=").strip()


def _rewrite(text: str) -> str:
    """Turn student notation into names the parser can evaluate.

    Single-letter calls like y(x) become applied unknown functions, so an ODE
    can talk about y without y being a plain variable. C1, C2, ... are
    arbitrary constants. A bare matrix literal is wrapped in Matrix().
    """
    for name in set(re.findall(r"\bC\d+\b", text)):
        _LOCALS.setdefault(name, sp.Symbol(name, real=True))

    def repl(match: re.Match) -> str:
        name, args = match.group(1), match.group(2)
        if name in _FUNCS:
            return match.group(0)
        if len(name) == 1 and name.isalpha():
            key = f"_fn_{name}"
            _LOCALS.setdefault(key, sp.Function(name))
            return f"{key}({args})"
        return match.group(0)

    prev = None
    while prev != text:
        prev = text
        text = re.sub(r"\b([A-Za-z]\w*)\(([^()]*)\)", repl, text)
    if text.strip().startswith("[["):
        text = f"Matrix({text.strip()})"
    return text


def _parse_side(text: str, evaluate: bool = True) -> sp.Basic:
    text = text.strip()
    if not text:
        raise ParseError("empty side")
    try:
        expr = parse_expr(text, local_dict=dict(_LOCALS), global_dict={"__builtins__": {}, **_sympy_globals()},
                          transformations=_TRANSFORMS, evaluate=evaluate)
    except Exception as exc:  # sympy raises many error types on bad input
        raise ParseError(f"could not parse {text!r}: {exc}") from exc
    if isinstance(expr, list):
        try:
            expr = sp.Matrix(expr)
        except Exception as exc:
            raise ParseError(f"not a matrix: {text!r}") from exc
    if isinstance(expr, sp.MatrixBase):
        if max(expr.shape) > 8:
            raise ParseError("matrix is too large")
        return expr
    if not isinstance(expr, sp.Expr):
        raise ParseError(f"not an expression: {text!r}")
    return expr


_GLOBALS_CACHE: dict | None = None


def _sympy_globals() -> dict:
    # parse_expr's generated code references a handful of sympy constructors.
    global _GLOBALS_CACHE
    if _GLOBALS_CACHE is None:
        _GLOBALS_CACHE = {name: getattr(sp, name) for name in
                          ("Integer", "Float", "Rational", "Symbol", "Function", "Mul", "Add", "Pow", "Number")}
    return _GLOBALS_CACHE


def _check_idents(text: str) -> None:
    for ident in _IDENT.findall(text):
        # implicit multiplication lets 'xy' mean x*y, so a run of letters is
        # fine as long as it isn't a function name we don't know.
        if ident in _FUNCS or len(ident) == 1:
            continue
        if any(ident.startswith(f) for f in _FUNCS) or not ident.isalpha():
            raise ParseError(f"unknown name {ident!r}")
        if len(ident) > 3:
            raise ParseError(f"unknown name {ident!r}")


def parse_statement(text: str, *, evaluate: bool = True) -> Statement:
    """Parse one line, e.g. '2*(x-3)+4 = 10', 'x > 3', 'diff(x^2, x)' or '[[1, 2], [3, 4]]'."""
    text = _clean(text)
    if not text or not _ALLOWED_CHARS.match(text):
        raise ParseError(f"disallowed characters in {text!r}")
    if re.search(r"\.\s*[A-Za-z_]", text) or _BANNED.search(text):
        raise ParseError("attribute access is not allowed")
    _check_idents(text)
    text = _rewrite(text)

    parts = _REL_SPLIT.split(text)
    if len(parts) == 1:
        side = _parse_side(parts[0], evaluate)
        if isinstance(side, sp.MatrixBase):
            return Statement("matrix", side)
        return Statement("expr", side)
    if len(parts) == 3:
        lhs, op, rhs = parts
        if op == "!=":
            raise ParseError("'!=' is not supported")
        left, right = _parse_side(lhs, evaluate), _parse_side(rhs, evaluate)
        if isinstance(left, sp.MatrixBase) or isinstance(right, sp.MatrixBase):
            raise ParseError("a matrix can't be part of a relation")
        kind = "eq" if op == "=" else "ineq"
        return Statement(kind, left, right, op)
    raise ParseError("more than one relation on a line")


# --------------------------------------------------------------------------
# Equivalence
# --------------------------------------------------------------------------

@dataclass
class StepCheck:
    verdict: Verdict
    # For Claude only: may contain solution values, which would give the answer away.
    detail: str = ""
    # Safe to show the student.
    note: str = ""


def _numeric_zero(expr: sp.Expr, syms: list[sp.Symbol], trials: int = 6) -> bool | None:
    """True if expr is ~0 at random points, False if clearly not, None if unsure."""
    rng = random.Random(1234)
    seen = 0
    for _ in range(trials * 3):
        point = {s: sp.Rational(rng.randint(-40, 40), rng.randint(1, 7)) for s in syms}
        try:
            val = complex(expr.subs(point).evalf())
        except (TypeError, ValueError, ZeroDivisionError):
            continue
        if val != val or abs(val) == float("inf"):  # NaN / inf: outside the domain
            continue
        if abs(val.imag) > 1e-8:  # branch cut, not evidence either way
            continue
        if abs(val.real) > 1e-8 * max(1.0, abs(val.real)) and abs(val.real) > 1e-8:
            return False
        seen += 1
        if seen >= trials:
            return True
    return None


def _evaluate(expr: sp.Basic) -> sp.Basic:
    """Compute derivatives, integrals, limits and determinants the student left written out."""
    if isinstance(expr, sp.MatrixBase):
        try:
            return expr.applyfunc(lambda entry: entry.doit() if isinstance(entry, sp.Expr) else entry)
        except Exception:
            return expr
    if isinstance(expr, sp.Expr):
        try:
            if expr.has(sp.Derivative, sp.Integral, sp.Limit, sp.Sum, sp.Determinant, sp.Inverse):
                return expr.doit()
        except Exception:
            return expr
    return expr


def exprs_equal(a: sp.Basic, b: sp.Basic) -> bool | None:
    """True if a and b are the same value, False if not, None if it can't be decided.

    Tries cheap algebraic cancellation before trig and log identities, and
    samples random points when the symbolic attempt is inconclusive.
    """
    a, b = _evaluate(a), _evaluate(b)
    # oo - oo is NaN, so identical infinities have to be caught before subtraction.
    # SymPy integers also compare equal to plain ints (the pigeonhole bound).
    try:
        if a == b:
            return True
    except Exception:
        pass
    if isinstance(a, sp.MatrixBase) or isinstance(b, sp.MatrixBase):
        if isinstance(a, sp.MatrixBase) and isinstance(b, sp.MatrixBase) and a.shape == b.shape:
            return bool(sp.simplify(a - b) == sp.zeros(*a.shape))
        return False
    if not isinstance(a, sp.Expr) or not isinstance(b, sp.Expr):
        return None
    diff = a - b
    if diff == 0:
        return True
    try:
        if sp.expand(diff) == 0 or sp.cancel(diff) == 0:
            return True
    except Exception:
        pass
    syms = sorted(diff.free_symbols, key=str)
    numeric = _numeric_zero(diff, syms) if syms else None
    # A log identity can look nonzero on the negative branch cut.
    if numeric is False and not diff.has(sp.log):
        return False
    try:
        if sp.simplify(diff) == 0 or sp.trigsimp(diff) == 0:
            return True
        if diff.has(sp.log) and sp.simplify(sp.expand_log(diff, force=True)) == 0:
            return True
    except Exception:
        pass
    if numeric is True:
        return True
    if not syms:
        try:
            return bool(sp.simplify(diff) == 0)
        except Exception:
            return None
    return None if numeric is None else False


def _contains_all(a: sp.FiniteSet, b: sp.FiniteSet) -> bool:
    return all(any(sp.simplify(x - y) == 0 for y in b) for x in a)


def _same_set(a: sp.Set, b: sp.Set) -> bool | None:
    if a == b:
        return True
    if isinstance(a, sp.FiniteSet) and isinstance(b, sp.FiniteSet):
        # Same numbers can print differently (sqrt(2)/2 vs 1/sqrt(2)).
        return _contains_all(a, b) and _contains_all(b, a)
    try:
        e1, e2 = sp.Complement(a, b).is_empty, sp.Complement(b, a).is_empty
    except Exception:
        return None
    if e1 is True and e2 is True:
        return True
    if e1 is False or e2 is False:
        return False
    return None


def _subset(a: sp.Set, b: sp.Set) -> bool | None:
    try:
        return a.is_subset(b)
    except Exception:
        return None


def _describe(s: sp.Set) -> str:
    if isinstance(s, sp.FiniteSet):
        return ", ".join(sp.sstr(x) for x in s) or "no solution"
    return sp.sstr(s)


def _solution_set(stmt: Statement, var: sp.Symbol) -> sp.Set:
    return sp.solveset(stmt.relational(), var, domain=sp.S.Reals)


def compare(prev: Statement, cur: Statement, target: sp.Symbol | None = None) -> StepCheck:
    """Does `cur` follow from `prev`?"""
    if prev.kind == "matrix" or cur.kind == "matrix":
        if prev.kind == cur.kind and prev.lhs.shape == cur.lhs.shape and prev.lhs == cur.lhs:
            return StepCheck("valid")
        return StepCheck("unknown")

    if prev.kind == "expr" and cur.kind == "expr":
        same = exprs_equal(prev.lhs, cur.lhs)
        if same is True:
            return StepCheck("valid")
        if same is False:
            return StepCheck("invalid", "this expression is not equal to the previous one",
                             "This isn't equal to the line above.")
        return StepCheck("unknown")

    if prev.kind == "expr" or cur.kind == "expr":
        return StepCheck("unknown")

    syms = sorted(prev.free | cur.free, key=str)

    if prev.kind == "eq" and cur.kind == "eq":
        e1 = prev.lhs - prev.rhs
        e2 = cur.lhs - cur.rhs
        if exprs_equal(e1, e2) is True:
            return StepCheck("valid")
        if e2 != 0:
            try:
                ratio = sp.simplify(e1 / e2)
            except Exception:
                ratio = None
            if ratio is not None and ratio.is_number and ratio != 0 and ratio.is_finite:
                return StepCheck("valid")

    if len(syms) == 1:
        var = syms[0]
        try:
            s1, s2 = _solution_set(prev, var), _solution_set(cur, var)
        except Exception:
            return StepCheck("unknown")
        if isinstance(s1, sp.ConditionSet) or isinstance(s2, sp.ConditionSet):
            return StepCheck("unknown")
        same = _same_set(s1, s2)
        if same is True:
            return StepCheck("valid")
        if same is None:
            return StepCheck("unknown")
        lost = _subset(s2, s1)
        gained = _subset(s1, s2)
        if gained is True:
            return StepCheck("caution", f"this step adds solution(s) the previous line didn't have; "
                                        f"before: {_describe(s1)}, now: {_describe(s2)}",
                             "This step can add extra solutions. Check your answers in the original problem.")
        if lost is True:
            return StepCheck("invalid", f"this step loses solution(s); before: {_describe(s1)}, now: {_describe(s2)}",
                             "This step loses a solution the line above had.")
        return StepCheck("invalid", f"solutions changed from {_describe(s1)} to {_describe(s2)}",
                         "This line has different solutions than the line above.")

    if not syms:
        # Two numeric statements: each is simply true or false.
        try:
            t1, t2 = bool(prev.relational()), bool(cur.relational())
        except TypeError:
            return StepCheck("unknown")
        if t1 == t2:
            return StepCheck("valid")
        return StepCheck("invalid", f"the previous line is {t1} but this one is {t2}",
                         "This line isn't true in the same way the line above is.")

    if target is not None and target in syms and prev.kind == "eq" and cur.kind == "eq":
        try:
            sol1 = sp.solve(sp.Eq(prev.lhs, prev.rhs), target)
            sol2 = sp.solve(sp.Eq(cur.lhs, cur.rhs), target)
        except Exception:
            return StepCheck("unknown")
        if not sol1 or not sol2:
            return StepCheck("unknown")
        if _same_set(sp.FiniteSet(*sol1), sp.FiniteSet(*sol2)):
            return StepCheck("valid")
        return StepCheck("invalid", f"solving for {target} gave {sol1} before and {sol2} now",
                         f"Solving this line for {target} doesn't give the same result as the line above.")

    return StepCheck("unknown")


def is_solved_form(stmt: Statement, target: sp.Symbol) -> bool:
    """'x = 4', '4 = x', 'x > 3': the target variable alone on one side."""
    if stmt.kind == "expr" or stmt.rhs is None:
        return False
    if stmt.lhs == target and target not in stmt.rhs.free_symbols:
        return True
    return stmt.rhs == target and target not in stmt.lhs.free_symbols


_UNFINISHED = (sp.Integral, sp.Derivative, sp.Limit, sp.Sum, sp.Determinant, sp.Inverse)


@lru_cache(maxsize=128)
def reference_value(expr: sp.Basic) -> sp.Basic:
    """Compute the destination before judging work; reuse it across board checks."""
    return sp.simplify(expr.doit())


def _written_expression(expr: sp.Basic) -> sp.Basic:
    """Normalize notation without doing the student's arithmetic.

    Term order, signs, and reduced fractions are spelling choices. Combining
    like terms, reducing fractions, and evaluating powers are still work.
    """
    if not expr.args:
        return expr
    args = [_written_expression(arg) for arg in expr.args]
    if expr.is_Add or expr.is_Mul:
        args = [child for arg in args for child in (arg.args if arg.func == expr.func else (arg,))]
        if expr.is_Mul:
            # A reciprocal is the ordinary written denominator of a fraction.
            integers = [arg for arg in args if arg.is_Integer and abs(arg) != 1]
            fractions = [arg for arg in args if arg.is_Rational and not arg.is_Integer]
            if len(integers) == len(fractions) == 1:
                numerator, fraction = integers[0], fractions[0]
                if abs(fraction.p) == 1 and sp.gcd(numerator, fraction.q) == 1:
                    args.remove(numerator)
                    args.remove(fraction)
                    args.append(numerator * fraction)
            # Unary signs and the numerator in 1/n need no further calculation.
            signs = sum(arg == -1 for arg in args)
            args = [arg for arg in args if arg not in (sp.S.One, -sp.S.One)]
            if signs % 2:
                numeric = next((i for i, arg in enumerate(args) if arg.is_Number), None)
                if numeric is None:
                    args.append(-sp.S.One)
                else:
                    args[numeric] = -args[numeric]
        if not args:
            return sp.S.One if expr.is_Mul else sp.S.Zero
        if len(args) == 1:
            return args[0]
        return expr.func(*sorted(args, key=sp.default_sort_key), evaluate=False)
    if expr.is_Pow:
        base, exponent = args
        if base.is_Integer and base != 0 and exponent == -1:
            return sp.Rational(1, base)
        return sp.Pow(base, exponent, evaluate=False)
    return expr.func(*args)


def is_simplified_answer(text: str) -> bool:
    """Completion requires evaluated operators and finished basic arithmetic.

    Equivalent expanded and factored answers are both allowed; no single
    symbolic spelling is required.
    """
    try:
        written = parse_statement(text, evaluate=False)
        evaluated = parse_statement(text)
        for raw, value in ((written.lhs, evaluated.lhs), (written.rhs, evaluated.rhs)):
            if raw is None:
                continue
            if raw.has(*_UNFINISHED) or value.has(*_UNFINISHED):
                return False
            if isinstance(raw, sp.MatrixBase):
                pairs = zip(raw, value)
            else:
                pairs = [(raw, value)]
            for before, after in pairs:
                if _written_expression(before) != _written_expression(after):
                    return False
                # Catch cancellable rational factors and elementary identities,
                # while allowing either expanded or factored polynomials.
                reduced = sp.trigsimp(sp.cancel(after))
                if sp.count_ops(reduced) < sp.count_ops(after):
                    return False
        return True
    except Exception:
        return False


@lru_cache(maxsize=128)
def _reference_solution(problem: str, target: sp.Symbol | None) -> sp.Basic | None:
    original = parse_statement(problem)
    if original.kind == "expr":
        return reference_value(original.lhs)
    if target is not None and original.kind in ("eq", "ineq") and target in original.free:
        return _solution_set(original, target)
    return None


def _is_numeric_answer(stmt: Statement, text: str) -> bool:
    """Numbers, fractions and radicals count; unfinished arithmetic does not."""
    if stmt.kind != "expr" or not stmt.lhs.is_number or not stmt.lhs.is_finite:
        return False
    number = r"(?:\d+(?:\.\d*)?|\.\d+)"
    atom = rf"(?:{number}|pi|E|sqrt\({number}\))"
    return re.fullmatch(rf"[+-]?{atom}(?:/[+-]?{atom})?", _clean(text).replace(" ", "")) is not None


def _answer_statement(stmt: Statement, original: Statement | None,
                      target: sp.Symbol | None, text: str) -> Statement:
    """Interpret a bare numeric answer as the value of the requested variable."""
    if (original is not None and original.kind == "eq" and target is not None
            and _is_numeric_answer(stmt, text)):
        return Statement("eq", target, stmt.lhs)
    return stmt


def _is_final_answer(stmt: Statement, original: Statement | None,
                     target: sp.Symbol | None, text: str, reference: sp.Basic | None) -> bool:
    """Check an answer against the problem, independently of the previous step."""
    if original is None or reference is None or not is_simplified_answer(text):
        return False
    if stmt.kind == "expr":
        return original.kind == "expr" and exprs_equal(reference, stmt.lhs) is True
    if target is None or not is_solved_form(stmt, target):
        return False
    if original.kind not in ("eq", "ineq") or target not in original.free:
        return False
    if isinstance(reference, sp.ConditionSet):
        return False
    return _same_set(reference, _solution_set(stmt, target)) is True


# --------------------------------------------------------------------------
# Whole-board check
# --------------------------------------------------------------------------

def check_steps(problem: str | None, steps: list[tuple[int, str]], target: str | None,
                task: str | None = None) -> dict:
    """Verify each step against the previous one.

    `steps` is [(line_number, sympy_text), ...] in board order; empty text means
    the line couldn't be transcribed as math. `task` is the tutor's label
    (differentiate, integrate, ode, ...); when it's empty the problem syntax
    decides. Each parsed result includes `final_answer`, checked against the original
    problem. Returns {"results": {line: {"verdict", "detail", "note", ...}}, "arrived": bool},
    where `detail` is for Claude only and `note` is safe to show the student.
    """
    from domains import check_domain, resolve_task

    resolved = resolve_task(problem or "", task)
    if resolved not in ("solve", "simplify", ""):
        advanced = check_domain(resolved, problem or "", list(steps), target)
        if advanced is not None:
            return advanced

    tsym = _SYMBOLS.get(target) if target and len(target) == 1 else None
    results: dict[int, dict] = {}

    prev: Statement | None = None
    if problem:
        try:
            prev = parse_statement(problem)
        except ParseError:
            prev = None
    original = prev
    if tsym is None and original is not None and original.kind in ("eq", "ineq") and len(original.free) == 1:
        tsym = next(iter(original.free))
    try:
        reference = _reference_solution(problem, tsym) if problem else None
    except Exception:
        reference = None

    arrived = False
    for line, text in steps:
        if not text.strip():
            results[line] = {"verdict": "unknown", "detail": "", "note": ""}
            continue
        try:
            cur = parse_statement(text)
        except ParseError as exc:
            results[line] = {"verdict": "unknown", "detail": str(exc), "note": ""}
            prev = None  # can't chain through a line we couldn't read
            continue
        cur = _answer_statement(cur, original, tsym, text)
        if prev is None:
            check = StepCheck("unknown")
        else:
            try:
                check = compare(prev, cur, tsym)
            except Exception as exc:  # never let one odd line break the board
                check = StepCheck("unknown", f"sympy error: {exc}")
        try:
            final_answer = _is_final_answer(cur, original, tsym, text, reference)
        except Exception:
            final_answer = False
        results[line] = {"verdict": check.verdict, "detail": check.detail, "note": check.note,
                         "final_answer": final_answer}
        arrived = arrived or final_answer
        prev = cur

    arrived = arrived and not any(r["verdict"] == "invalid" for r in results.values())
    return {"results": results, "arrived": arrived}

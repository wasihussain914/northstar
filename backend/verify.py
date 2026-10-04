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
    # Built from an explicit list of roots ("x = 0 or x = 5"): counts as
    # solved form even though the variable isn't alone on one side.
    solved: bool = False

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


def _parse_side(text: str) -> sp.Basic:
    text = text.strip()
    if not text:
        raise ParseError("empty side")
    try:
        expr = parse_expr(text, local_dict=dict(_LOCALS), global_dict={"__builtins__": {}, **_sympy_globals()},
                          transformations=_TRANSFORMS, evaluate=True)
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


def parse_statement(text: str) -> Statement:
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
        side = _parse_side(parts[0])
        if isinstance(side, sp.MatrixBase):
            return Statement("matrix", side)
        return Statement("expr", side)
    if len(parts) == 3:
        lhs, op, rhs = parts
        if op == "!=":
            raise ParseError("'!=' is not supported")
        left, right = _parse_side(lhs), _parse_side(rhs)
        if isinstance(left, sp.MatrixBase) or isinstance(right, sp.MatrixBase):
            raise ParseError("a matrix can't be part of a relation")
        kind = "eq" if op == "=" else "ineq"
        return Statement(kind, left, right, op)
    roots = _parse_roots(text)
    if roots is not None:
        return roots
    raise ParseError("more than one relation on a line")


def _parse_roots(text: str) -> Statement | None:
    """An explicit list of solutions: 'x = 0 or x = 5', also comma-separated.

    Collapsed into the equation (x - 0)(x - 5) = 0, whose solution set is the
    answer, and marked solved so the board can arrive on it.
    """
    parts = re.split(r"\s+or\s+|,", text)
    if len(parts) < 2:
        return None
    sym = None
    vals = []
    for part in parts:
        part = part.strip()
        if not part:
            return None
        try:
            stmt = parse_statement(part)
        except ParseError:
            return None
        if stmt.kind != "eq" or stmt.rhs is None:
            return None
        if isinstance(stmt.lhs, sp.Symbol) and not stmt.rhs.free_symbols:
            s, v = stmt.lhs, stmt.rhs
        elif isinstance(stmt.rhs, sp.Symbol) and not stmt.lhs.free_symbols:
            s, v = stmt.rhs, stmt.lhs
        else:
            return None
        if sym is None:
            sym = s
        elif s != sym:
            return None
        vals.append(v)
    product = sp.Mul(*[(sym - v) for v in vals])
    return Statement("eq", product, sp.Integer(0), "=", solved=True)


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
    """'x = 4', '4 = x', 'x > 3', or an explicit root list ('x = 0 or x = 5')."""
    if stmt.solved:
        return target in getattr(stmt.lhs, "free_symbols", set())
    if stmt.kind == "expr" or stmt.rhs is None:
        return False
    if stmt.lhs == target and target not in stmt.rhs.free_symbols:
        return True
    return stmt.rhs == target and target not in stmt.lhs.free_symbols


# --------------------------------------------------------------------------
# Whole-board check
# --------------------------------------------------------------------------

def check_steps(problem: str | None, steps: list[tuple[int, str]], target: str | None,
                task: str | None = None) -> dict:
    """Verify each step against the previous one.

    `steps` is [(line_number, sympy_text), ...] in board order; empty text means
    the line couldn't be transcribed as math. `task` is the tutor's label
    (differentiate, integrate, ode, ...); when it's empty the problem syntax
    decides. Returns {"results": {line: {"verdict", "detail", "note"}}, "arrived": bool},
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

    last: Statement | None = None
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
        if prev is None:
            check = StepCheck("unknown")
        else:
            try:
                check = compare(prev, cur, tsym)
            except Exception as exc:  # never let one odd line break the board
                check = StepCheck("unknown", f"sympy error: {exc}")
        results[line] = {"verdict": check.verdict, "detail": check.detail, "note": check.note}
        prev = cur
        last = cur

    arrived = False
    if last is not None and tsym is not None and is_solved_form(last, tsym):
        no_errors = all(r["verdict"] in ("valid", "caution") for r in results.values())
        if original is not None and original.kind != "expr":
            try:
                arrived = _same_set(_solution_set(original, tsym), _solution_set(last, tsym)) is True
            except Exception:
                arrived = False
        else:
            arrived = no_errors
    return {"results": results, "arrived": arrived}

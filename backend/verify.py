"""Deterministic step checking with SymPy.

Claude transcribes the handwriting; this module decides whether each step
follows from the one before it. A verdict is one of:

    valid    - the step is mathematically equivalent to the previous one
    invalid  - it is not (a wrong turn)
    caution  - it keeps every solution but adds extra ones (e.g. squaring)
    unknown  - SymPy couldn't decide; the caller falls back to Claude's judgment

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
    "pi": sp.pi,
    "E": sp.E,
}
# Every single letter is a real-valued variable, so names like N, S, Q or I
# never resolve to sympy objects.
_SYMBOLS = {c: sp.Symbol(c, real=True) for c in string.ascii_letters if c != "E"}
_LOCALS = {**_SYMBOLS, **_FUNCS}

_ALLOWED_CHARS = re.compile(r"^[0-9A-Za-z+\-*/^().,=<>! ]+$")
_IDENT = re.compile(r"[A-Za-z]+")
_REL_SPLIT = re.compile(r"(<=|>=|!=|<|>|=)")
_REL_CLASS = {"<": sp.StrictLessThan, ">": sp.StrictGreaterThan, "<=": sp.LessThan, ">=": sp.GreaterThan}

_UNICODE = {
    "−": "-", "–": "-", "·": "*", "×": "*", "÷": "/", "√": "sqrt",
    "≤": "<=", "≥": ">=", "≠": "!=", "π": "pi", "²": "^2", "³": "^3",
}


class ParseError(ValueError):
    pass


@dataclass(frozen=True)
class Statement:
    """One parsed line of work."""

    kind: Literal["eq", "ineq", "expr"]
    lhs: sp.Expr
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


def _parse_side(text: str) -> sp.Expr:
    text = text.strip()
    if not text:
        raise ParseError("empty side")
    try:
        expr = parse_expr(text, local_dict=dict(_LOCALS), global_dict={"__builtins__": {}, **_sympy_globals()},
                          transformations=_TRANSFORMS, evaluate=True)
    except Exception as exc:  # sympy raises many error types on bad input
        raise ParseError(f"could not parse {text!r}: {exc}") from exc
    if not isinstance(expr, sp.Expr):
        raise ParseError(f"not an expression: {text!r}")
    return expr


_GLOBALS_CACHE: dict | None = None


def _sympy_globals() -> dict:
    # parse_expr's generated code references a handful of sympy constructors.
    global _GLOBALS_CACHE
    if _GLOBALS_CACHE is None:
        _GLOBALS_CACHE = {name: getattr(sp, name) for name in
                          ("Integer", "Float", "Rational", "Symbol", "Function", "Mul", "Add", "Pow")}
    return _GLOBALS_CACHE


def parse_statement(text: str) -> Statement:
    """Parse one line, e.g. '2*(x-3)+4 = 10', 'x > 3' or '3x + 6 - x'."""
    text = _clean(text)
    if not text or not _ALLOWED_CHARS.match(text):
        raise ParseError(f"disallowed characters in {text!r}")
    if re.search(r"\.\s*[A-Za-z_]", text):
        raise ParseError("attribute access is not allowed")
    for ident in _IDENT.findall(text):
        # implicit multiplication lets 'xy' mean x*y, so a run of letters is
        # fine as long as it isn't a function name we don't know.
        if ident in _FUNCS or len(ident) == 1:
            continue
        if any(ident.startswith(f) for f in _FUNCS) or not ident.isalpha():
            raise ParseError(f"unknown name {ident!r}")
        if len(ident) > 3:
            raise ParseError(f"unknown name {ident!r}")

    parts = _REL_SPLIT.split(text)
    if len(parts) == 1:
        return Statement("expr", _parse_side(parts[0]))
    if len(parts) == 3:
        lhs, op, rhs = parts
        if op == "!=":
            raise ParseError("'!=' is not supported")
        kind = "eq" if op == "=" else "ineq"
        return Statement(kind, _parse_side(lhs), _parse_side(rhs), op)
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
        if abs(val) > 1e-8 * max(1.0, abs(val)) and abs(val) > 1e-8:
            return False
        seen += 1
        if seen >= trials:
            return True
    return None


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
    if prev.kind == "expr" and cur.kind == "expr":
        diff = sp.expand(prev.lhs - cur.lhs)
        if diff == 0:
            return StepCheck("valid")
        zero = _numeric_zero(prev.lhs - cur.lhs, sorted(prev.free | cur.free, key=str))
        if zero is True:
            return StepCheck("valid")
        if zero is False:
            return StepCheck("invalid", "this expression is not equal to the previous one",
                             "This isn't equal to the line above.")
        return StepCheck("unknown")

    if prev.kind == "expr" or cur.kind == "expr":
        return StepCheck("unknown")

    syms = sorted(prev.free | cur.free, key=str)

    if prev.kind == "eq" and cur.kind == "eq":
        e1 = prev.lhs - prev.rhs
        e2 = cur.lhs - cur.rhs
        if sp.expand(e1 - e2) == 0:
            return StepCheck("valid")
        if e2 != 0:
            ratio = sp.simplify(e1 / e2)
            if ratio.is_number and ratio != 0 and ratio.is_finite:
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


# --------------------------------------------------------------------------
# Whole-board check
# --------------------------------------------------------------------------

def check_steps(problem: str | None, steps: list[tuple[int, str]], target: str | None) -> dict:
    """Verify each step against the previous one.

    `steps` is [(line_number, sympy_text), ...] in board order; empty text means
    the line couldn't be transcribed as math. Returns
    {"results": {line: {"verdict", "detail", "note"}}, "arrived": bool}, where
    `detail` is for Claude only and `note` is safe to show the student.
    """
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

"""Step checking beyond algebra.

`verify.check_steps` handles equations, inequalities and expression rewrites.
This module takes over when the problem is calculus, a differential equation,
a matrix, a sum, a number-theory calculation, a proof, pigeonhole, or a
chemical equation to balance. Physics that is really an ODE (motion) comes
through the ODE checker; a physics problem that is just an equation falls
back to algebra.

The dialect Claude is asked to transcribe into is documented in tutor.py.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import sympy as sp
from sympy.core.function import AppliedUndef

from verify import (
    ParseError,
    Statement,
    StepCheck,
    _SYMBOLS,
    exprs_equal,
    parse_statement,
)

_TASKS = {
    "solve", "simplify", "differentiate", "integrate", "limit", "ode", "pde",
    "linalg", "grad", "sum", "number_theory", "prove", "pigeonhole", "balance",
    "physics", "other",
}


def infer_task(problem: str) -> str:
    """Guess the task from the transcribed problem, when the tutor didn't set one."""
    raw = problem.strip()
    compact = re.sub(r"\s+", "", raw)
    lower = compact.lower()
    if lower.startswith("pigeonhole("):
        return "pigeonhole"
    if lower.startswith("balance(") or raw.lower().startswith("balance "):
        return "balance"
    if raw.lower().startswith("prove ") or lower.startswith("prove("):
        return "prove"
    if (lower.startswith("gcd(") or lower.startswith("modinv(") or compact.startswith("Mod(")
            or lower.startswith("mod(") or " mod " in f" {raw} "):
        return "number_theory"
    if lower.startswith("summation("):
        return "sum"
    if lower.startswith("grad("):
        return "grad"
    if lower.startswith("det(") or lower.startswith("inv(") or lower.startswith("rref(") or compact.startswith("[["):
        return "linalg"
    # u(x, t) inside a diff(...) equation is a PDE. y(x) inside an equation is an ODE.
    if re.search(r"\b[A-Za-z]\([^()\n]*,", raw) and "diff(" in compact and "=" in raw:
        return "pde"
    if re.search(r"diff\(\s*[A-Za-z]\(", compact) and "=" in raw:
        return "ode"
    if lower.startswith("diff("):
        return "differentiate"
    if lower.startswith("integrate("):
        return "integrate"
    if lower.startswith("limit(") or lower.startswith("limleft(") or lower.startswith("limright("):
        return "limit"
    return "solve"


def resolve_task(problem: str, task: str | None) -> str:
    """Syntax wins when it names an operator; an explicit task covers a bare expression."""
    inferred = infer_task(problem)
    given = (task or "").strip().lower()
    if inferred != "solve":
        return inferred
    if given in _TASKS and given not in ("", "other", "solve", "simplify"):
        return given
    return "solve"


def check_domain(task: str, problem: str, steps: list[tuple[int, str]], target: str | None) -> dict | None:
    handler = {
        "differentiate": check_differentiate,
        "integrate": check_integrate,
        "limit": check_limit,
        "ode": check_ode,
        "pde": check_pde,
        "linalg": check_linalg,
        "grad": check_grad,
        "sum": check_sum,
        "number_theory": check_number_theory,
        "prove": check_prove,
        "pigeonhole": check_pigeonhole,
        "balance": check_balance,
        "physics": check_physics,
    }.get(task)
    if handler is None:
        return None
    return handler(problem, steps, target)


# --------------------------------------------------------------------------
# Shared board walk
# --------------------------------------------------------------------------

def _row(verdict: str, detail: str = "", note: str = "") -> dict:
    return {"verdict": verdict, "detail": detail, "note": note}


def _from_check(check: StepCheck) -> dict:
    return _row(check.verdict, check.detail, check.note)


@dataclass
class _Judged:
    check: StepCheck
    stmt: Statement | None = None
    answer: bool = False


def _walk(steps: list[tuple[int, str]], judge) -> dict:
    results: dict[int, dict] = {}
    prev: Statement | None = None
    any_bad = False
    last_answer = False
    for line, text in steps:
        if not str(text).strip():
            results[line] = _row("unknown")
            prev = None
            last_answer = False
            continue
        try:
            judged = judge(str(text), prev)
        except ParseError as exc:
            results[line] = _row("unknown", str(exc))
            prev = None
            last_answer = False
            continue
        except Exception as exc:
            results[line] = _row("unknown", f"sympy error: {exc}")
            prev = None
            last_answer = False
            continue
        results[line] = _from_check(judged.check)
        if judged.check.verdict == "invalid":
            any_bad = True
        if judged.stmt is not None and judged.check.verdict != "unknown":
            prev = judged.stmt
        last_answer = bool(judged.answer and judged.check.verdict == "valid")
    return {"results": results, "arrived": last_answer and not any_bad}


def _var_of(expr: sp.Basic, target: str | None) -> sp.Symbol | None:
    if target and len(target) == 1 and target in _SYMBOLS:
        return _SYMBOLS[target]
    syms = sorted(getattr(expr, "free_symbols", ()), key=str)
    if len(syms) == 1:
        return syms[0]
    return None


def _expr_value(stmt: Statement) -> sp.Expr | None:
    if stmt.kind == "expr" and isinstance(stmt.lhs, sp.Expr):
        return stmt.lhs
    return None


def _successive_diffs(deriv: sp.Derivative) -> list[sp.Expr]:
    """The original function, then each partial in order, ending at the answer."""
    cur = deriv.expr
    out = [cur]
    for var in deriv.variables:
        cur = sp.diff(cur, var)
        out.append(cur)
    return out


# --------------------------------------------------------------------------
# Calculus
# --------------------------------------------------------------------------

def check_differentiate(problem: str, steps, target: str | None) -> dict | None:
    try:
        stmt = parse_statement(problem)
    except ParseError:
        return None
    if isinstance(stmt.lhs, sp.Derivative):
        deriv = stmt.lhs
    elif stmt.kind == "expr":
        var = _var_of(stmt.lhs, target)
        if var is None:
            return None
        deriv = sp.Derivative(stmt.lhs, var)
    else:
        return None
    stages = _successive_diffs(deriv)
    final = stages[-1]
    partials = stages[:-1]

    def judge(text: str, prev: Statement | None) -> _Judged:
        cur = parse_statement(text)
        val = _expr_value(cur)
        if val is None:
            return _Judged(StepCheck("unknown"), cur)
        if exprs_equal(val, final) is True:
            return _Judged(StepCheck("valid"), cur, True)
        if any(exprs_equal(val, stage) is True for stage in partials):
            return _Judged(StepCheck("valid"), cur, False)
        if prev is not None and _expr_value(prev) is not None and exprs_equal(val, _expr_value(prev)) is True:
            return _Judged(StepCheck("valid"), cur, False)
        return _Judged(StepCheck("invalid", "not equal to the derivative",
                                 "This isn't the derivative of that function."), cur)

    return _walk(steps, judge)


def _is_definite(integ: sp.Integral) -> bool:
    return any(len(lim) == 3 for lim in integ.limits)


def _split_diff(text: str, var: str) -> tuple[str, str] | None:
    """'du = 2*x*dx' -> ('u', '2*x'); also 'du/dx = 2*x'. None if not a differential."""
    m = re.match(rf"^\s*d\s*([a-zA-Z])\s*/\s*d\s*{re.escape(var)}\s*=\s*(.+)$", text)
    if m:
        return m.group(1), m.group(2)
    m = re.match(r"^\s*d\s*([a-zA-Z])\s*=\s*(.+)$", text)
    if m is None:
        return None
    rhs = m.group(2).strip()
    stripped = re.sub(rf"(?:\*\s*)?d\s*{re.escape(var)}\s*$", "", rhs).strip()
    if stripped == rhs:
        return None  # no d<var> factor: not a differential in this variable
    return m.group(1), (stripped or "1")


def check_integrate(problem: str, steps, target: str | None) -> dict | None:
    try:
        stmt = parse_statement(problem)
    except ParseError:
        return None
    if isinstance(stmt.lhs, sp.Integral):
        integ = stmt.lhs
    elif stmt.kind == "expr":
        var = _var_of(stmt.lhs, target)
        if var is None:
            return None
        integ = sp.Integral(stmt.lhs, var)
    else:
        return None

    var = integ.limits[0][0]
    definite = _is_definite(integ)
    values: list[sp.Expr] = []
    node: sp.Basic = integ
    while isinstance(node, sp.Integral):
        try:
            values.append(node.doit())
        except Exception:
            break
        node = node.function
    final = values[0] if values else None
    inner_values = values[1:]
    integrand = integ.function

    def is_antiderivative(val: sp.Expr) -> bool:
        try:
            return exprs_equal(sp.diff(val, var), integrand) is True
        except Exception:
            return False

    # Substitution / by-parts bookkeeping. "u = x^2" is a definition — true by
    # choice — and "du = 2*x*dx" is then provably right or wrong: differentiate
    # the definition. Definitions are collected from the whole board up front,
    # so "dv = exp(x)*dx" still verifies when "v = exp(x)" is written below it.
    defs: dict[str, sp.Expr] = {}
    for _line, _text in steps:
        try:
            st = parse_statement(str(_text))
        except ParseError:
            continue
        if (st.kind == "eq" and isinstance(st.lhs, sp.Symbol) and str(st.lhs) != str(var)
                and st.rhs is not None and isinstance(st.rhs, sp.Expr)):
            defs.setdefault(str(st.lhs), st.rhs)

    def judge(text: str, prev: Statement | None) -> _Judged:
        sub = _split_diff(text, str(var))
        if sub is not None:
            name, body = sub
            base = defs.get(name)
            val = _expr_value(parse_statement(body))
            if base is None or val is None:
                return _Judged(StepCheck("unknown"))
            want = sp.diff(base, var)
            if exprs_equal(want, val) is True:
                return _Judged(StepCheck("valid"))
            return _Judged(StepCheck(
                "invalid", f"d{name} should be ({want}) d{var}, not ({val}) d{var}",
                f"Differentiate your {name} again: this d{name} doesn't match it."))
        cur = parse_statement(text)
        if (cur.kind == "eq" and isinstance(cur.lhs, sp.Symbol) and str(cur.lhs) in defs
                and defs[str(cur.lhs)] == cur.rhs):
            return _Judged(StepCheck("valid"))  # choosing parts is true by definition
        val = _expr_value(cur)
        if val is None:
            return _Judged(StepCheck("unknown"), cur)
        if definite and final is not None and exprs_equal(val, final) is True:
            return _Judged(StepCheck("valid"), cur, True)
        if not definite and is_antiderivative(val):
            return _Judged(StepCheck("valid"), cur, True)
        if any(exprs_equal(val, piece) is True for piece in inner_values):
            return _Judged(StepCheck("valid"), cur, False)
        if exprs_equal(val, integrand) is True or (isinstance(node, sp.Expr) and exprs_equal(val, node) is True):
            return _Judged(StepCheck("valid"), cur, False)
        if definite and is_antiderivative(val):
            return _Judged(StepCheck("valid"), cur, False)
        if prev is not None and _expr_value(prev) is not None and exprs_equal(val, _expr_value(prev)) is True:
            return _Judged(StepCheck("valid"), cur, False)
        note = ("This isn't the value of that integral." if definite
                else "Differentiating this doesn't give back the integrand.")
        return _Judged(StepCheck("invalid", "integral step does not match", note), cur)

    return _walk(steps, judge)


def check_limit(problem: str, steps, target: str | None) -> dict | None:
    try:
        stmt = parse_statement(problem)
    except ParseError:
        return None
    if not isinstance(stmt.lhs, sp.Limit):
        return None
    inside = stmt.lhs.args[0]
    try:
        final = stmt.lhs.doit()
    except Exception:
        return None

    def judge(text: str, prev: Statement | None) -> _Judged:
        cur = parse_statement(text)
        val = _expr_value(cur)
        if val is None:
            return _Judged(StepCheck("unknown"), cur)
        if exprs_equal(val, final) is True:
            return _Judged(StepCheck("valid"), cur, True)
        if exprs_equal(val, inside) is True:
            return _Judged(StepCheck("valid"), cur, False)
        if prev is not None and _expr_value(prev) is not None and exprs_equal(val, _expr_value(prev)) is True:
            return _Judged(StepCheck("valid"), cur, False)
        return _Judged(StepCheck("invalid", "not the limit value",
                                 "This isn't the value of that limit."), cur)

    return _walk(steps, judge)


def check_sum(problem: str, steps, target: str | None) -> dict | None:
    try:
        stmt = parse_statement(problem)
    except ParseError:
        return None
    if not isinstance(stmt.lhs, sp.Sum):
        return None
    try:
        final = stmt.lhs.doit()
    except Exception:
        return None
    term = stmt.lhs.function

    def judge(text: str, prev: Statement | None) -> _Judged:
        cur = parse_statement(text)
        val = _expr_value(cur)
        if val is None:
            return _Judged(StepCheck("unknown"), cur)
        if exprs_equal(val, final) is True:
            return _Judged(StepCheck("valid"), cur, True)
        if exprs_equal(val, term) is True:
            return _Judged(StepCheck("valid"), cur, False)
        if prev is not None and _expr_value(prev) is not None and exprs_equal(val, _expr_value(prev)) is True:
            return _Judged(StepCheck("valid"), cur, False)
        return _Judged(StepCheck("invalid", "not the closed form",
                                 "This isn't a closed form of that sum."), cur)

    return _walk(steps, judge)


# --------------------------------------------------------------------------
# Differential equations
# --------------------------------------------------------------------------

def _clauses(problem: str) -> list[str]:
    return [part.strip() for part in problem.split(";") if part.strip()]


def _applied(expr: sp.Basic) -> list[AppliedUndef]:
    return sorted(expr.atoms(AppliedUndef), key=str)


def _satisfies(residual: sp.Expr, applied: AppliedUndef, sol: sp.Expr) -> bool:
    try:
        plugged = sp.simplify(residual.subs(applied, sol).doit())
    except Exception:
        return False
    return exprs_equal(plugged, 0) is True


def _constants(sol: sp.Expr, indeps: tuple, residual: sp.Expr) -> list[sp.Symbol]:
    reserved = set(indeps) | set(residual.free_symbols)
    return [sym for sym in sol.free_symbols if sym not in reserved]


def _solution_of(stmt: Statement, func) -> sp.Expr | None:
    if stmt.kind != "eq":
        return None
    if isinstance(stmt.lhs, AppliedUndef) and stmt.lhs.func == func:
        return stmt.rhs if isinstance(stmt.rhs, sp.Expr) else None
    if isinstance(stmt.rhs, AppliedUndef) and stmt.rhs.func == func:
        return stmt.lhs if isinstance(stmt.lhs, sp.Expr) else None
    return None


def _conditions_hold(sol: sp.Expr, conds: list[str], indeps: tuple, func) -> bool:
    for cond in conds:
        try:
            stmt = parse_statement(cond)
        except ParseError:
            return False
        if stmt.kind != "eq" or not isinstance(stmt.lhs, AppliedUndef) or stmt.lhs.func != func:
            return False
        if len(stmt.lhs.args) != len(indeps):
            return False
        try:
            got = sol.subs(dict(zip(indeps, stmt.lhs.args)))
        except Exception:
            return False
        if exprs_equal(got, stmt.rhs) is not True:
            return False
    return True


def check_ode(problem: str, steps, target: str | None) -> dict | None:
    parts = _clauses(problem)
    if not parts:
        return None
    try:
        ode = parse_statement(parts[0])
    except ParseError:
        return None
    if ode.kind != "eq" or ode.rhs is None:
        return None
    residual = ode.lhs - ode.rhs
    funcs = _applied(residual)
    if len(funcs) != 1:
        return None
    applied = funcs[0]
    try:
        order = int(sp.ode_order(sp.Eq(ode.lhs, ode.rhs), applied))
    except Exception:
        order = 1
    indeps = applied.args
    conds = parts[1:]

    def judge(text: str, prev: Statement | None) -> _Judged:
        cur = parse_statement(text)
        sol = _solution_of(cur, applied.func)
        if sol is None:
            # Characteristic equations and other setup aren't the solution yet.
            return _Judged(StepCheck("unknown"), None)
        if not _satisfies(residual, applied, sol):
            return _Judged(StepCheck("invalid", "residual is not zero",
                                     "This doesn't satisfy the differential equation."), cur)
        if not _conditions_hold(sol, conds, indeps, applied.func):
            return _Judged(StepCheck("invalid", "initial condition missed",
                                     "This solves the equation but misses a condition."), cur)
        if conds or len(_constants(sol, indeps, residual)) >= order:
            return _Judged(StepCheck("valid"), cur, True)
        return _Judged(StepCheck(
            "caution", "particular solution; general solution needs more arbitrary constants",
            "This solves the equation, but the general solution still needs an arbitrary constant.",
        ), cur, False)

    return _walk(steps, judge)


def check_pde(problem: str, steps, target: str | None) -> dict | None:
    # Same substitution test as an ODE, without counting arbitrary constants.
    # A PDE solution is arrived at when a proposed u(x, t) = ... plugs in cleanly.
    return _check_functional_equation(problem, steps)


def check_physics(problem: str, steps, target: str | None) -> dict | None:
    # Constant acceleration and similar motion problems are ODEs. Anything else
    # (a kinematic equation, an energy balance) is ordinary algebra.
    return check_ode(problem, steps, target)


def _check_functional_equation(problem: str, steps) -> dict | None:
    parts = _clauses(problem)
    if not parts:
        return None
    try:
        eq = parse_statement(parts[0])
    except ParseError:
        return None
    if eq.kind != "eq" or eq.rhs is None:
        return None
    residual = eq.lhs - eq.rhs
    funcs = _applied(residual)
    if len(funcs) != 1:
        return None
    applied = funcs[0]

    def judge(text: str, prev: Statement | None) -> _Judged:
        cur = parse_statement(text)
        sol = _solution_of(cur, applied.func)
        if sol is None:
            return _Judged(StepCheck("unknown"), None)
        if _satisfies(residual, applied, sol):
            return _Judged(StepCheck("valid"), cur, True)
        return _Judged(StepCheck("invalid", "residual is not zero",
                                 "This doesn't satisfy the equation."), cur)

    return _walk(steps, judge)


# --------------------------------------------------------------------------
# Linear algebra
# --------------------------------------------------------------------------

def _unwrap_call(problem: str, name: str) -> str | None:
    match = re.fullmatch(rf"{name}\((.*)\)", problem.strip(), flags=re.I | re.S)
    if not match:
        return None
    return match.group(1).strip()


def _matrix_of(stmt: Statement) -> sp.Matrix | None:
    if stmt.kind == "matrix" and isinstance(stmt.lhs, sp.MatrixBase):
        return sp.Matrix(stmt.lhs)
    return None


def _row_equivalent(a: sp.Matrix, b: sp.Matrix) -> bool | None:
    if a.shape != b.shape or max(a.shape) > 8:
        return None
    try:
        return a.rref()[0] == b.rref()[0]
    except Exception:
        return None


def check_linalg(problem: str, steps, target: str | None) -> dict | None:
    raw = problem.strip()
    if raw.lower().startswith("det("):
        return _check_scalar_operator(raw, steps, "This isn't the determinant of that matrix.")
    if raw.lower().startswith("inv("):
        return _check_inverse(raw, steps)
    if raw.lower().startswith("rref("):
        inner = _unwrap_call(raw, "rref")
        if inner is None:
            return None
        raw = inner
    if raw.startswith("["):
        return _check_rref(raw, steps)
    return None


def _check_scalar_operator(problem: str, steps, note: str) -> dict | None:
    try:
        stmt = parse_statement(problem)
    except ParseError:
        return None
    if stmt.kind != "expr":
        return None
    final = stmt.lhs

    def judge(text: str, prev: Statement | None) -> _Judged:
        cur = parse_statement(text)
        val = _expr_value(cur)
        if val is None:
            return _Judged(StepCheck("unknown"), cur)
        if exprs_equal(val, final) is True:
            return _Judged(StepCheck("valid"), cur, True)
        if prev is not None and _expr_value(prev) is not None and exprs_equal(val, _expr_value(prev)) is True:
            return _Judged(StepCheck("valid"), cur, False)
        return _Judged(StepCheck("invalid", "scalar operator mismatch", note), cur)

    return _walk(steps, judge)


def _check_inverse(problem: str, steps) -> dict | None:
    try:
        stmt = parse_statement(problem)
    except ParseError:
        return None
    if not isinstance(stmt.lhs, sp.Inverse):
        return None
    base = sp.Matrix(stmt.lhs.args[0])
    try:
        final = sp.Matrix(stmt.lhs.doit())
    except Exception:
        return None

    def judge(text: str, prev: Statement | None) -> _Judged:
        cur = parse_statement(text)
        mat = _matrix_of(cur)
        if mat is None:
            return _Judged(StepCheck("unknown"), cur)
        try:
            matches = mat == final or sp.simplify(base * mat - sp.eye(base.rows)) == sp.zeros(base.rows)
        except Exception:
            matches = False
        if matches:
            return _Judged(StepCheck("valid"), cur, True)
        return _Judged(StepCheck("invalid", "not the inverse",
                                 "Multiplying this by the original matrix doesn't give the identity."), cur)

    return _walk(steps, judge)


def _check_rref(problem: str, steps) -> dict | None:
    try:
        original = _matrix_of(parse_statement(problem))
    except ParseError:
        return None
    if original is None:
        return None
    try:
        reduced = original.rref()[0]
    except Exception:
        return None

    anchor = original
    prev = original

    def judge(text: str, _prev: Statement | None) -> _Judged:
        nonlocal anchor, prev
        cur = parse_statement(text)
        mat = _matrix_of(cur)
        if mat is None:
            return _Judged(StepCheck("unknown"), cur)
        same_as_prev = _row_equivalent(prev, mat)
        same_as_anchor = _row_equivalent(anchor, mat)
        if same_as_prev is True:
            prev = mat
            anchor = mat
            return _Judged(StepCheck("valid"), cur, mat == reduced)
        if same_as_anchor is True:
            # A correction: back to a matrix with the same solutions as the last good step.
            prev = mat
            anchor = mat
            return _Judged(StepCheck("valid"), cur, mat == reduced)
        prev = mat
        return _Judged(StepCheck("invalid", "rref changed",
                                 "This matrix isn't row-equivalent to the previous one."), cur)

    return _walk(steps, judge)


def check_grad(problem: str, steps, target: str | None) -> dict | None:
    try:
        stmt = parse_statement(problem)
    except ParseError:
        return None
    expected = _matrix_of(stmt)
    if expected is None:
        return None

    def _same(a: sp.Matrix, b: sp.Matrix) -> bool:
        if a.shape == b.shape and a == b:
            return True
        if 1 in a.shape and a.T.shape == b.shape and a.T == b:
            return True
        return False

    def judge(text: str, prev: Statement | None) -> _Judged:
        cur = parse_statement(text)
        mat = _matrix_of(cur)
        if mat is None:
            return _Judged(StepCheck("unknown"), cur)
        if _same(mat, expected):
            return _Judged(StepCheck("valid"), cur, True)
        return _Judged(StepCheck("invalid", "gradient mismatch",
                                 "This isn't the gradient of that function."), cur)

    return _walk(steps, judge)


# --------------------------------------------------------------------------
# Number theory
# --------------------------------------------------------------------------

def check_number_theory(problem: str, steps, target: str | None) -> dict | None:
    raw = problem.strip()
    lower = re.sub(r"\s+", "", raw).lower()
    if lower.startswith("gcd("):
        return _check_gcd(raw, steps)
    if " mod " in f" {raw} ":
        return _check_congruence(raw, steps)
    if lower.startswith("modinv(") or lower.startswith("mod(") or raw.startswith("Mod("):
        return _check_scalar_operator(raw, steps, "This isn't the value of that expression.")
    return None


_DIV_STEP = re.compile(
    r"^\s*(.+?)\s*=\s*(.+?)\s*\*\s*(.+?)\s*(?:\+\s*(.+?)\s*)?$")


def _as_int(text: str) -> int | None:
    try:
        stmt = parse_statement(text)
    except ParseError:
        return None
    val = _expr_value(stmt)
    if val is None or not getattr(val, "is_integer", False):
        return None
    return int(val)


def _check_gcd(problem: str, steps) -> dict | None:
    match = re.fullmatch(r"gcd\((.*)\)", re.sub(r"\s+", "", problem), flags=re.I)
    if not match:
        return None
    parts = match.group(1).split(",")
    if len(parts) != 2:
        return None
    a, b = _as_int(parts[0]), _as_int(parts[1])
    if a is None or b is None:
        return None
    goal = int(sp.gcd(a, b))
    pair = (a, b)
    last_remainder: int | None = None

    def judge(text: str, prev: Statement | None) -> _Judged:
        nonlocal pair, last_remainder
        div = _DIV_STEP.match(text.strip())
        if div:
            left, quot, right, rem = (_as_int(div.group(i)) for i in range(1, 5))
            if None in (left, quot, right) or rem is None and div.group(4) is not None:
                return _Judged(StepCheck("unknown"))
            rem = 0 if rem is None else rem
            uses_pair = {left, right} == set(pair)
            arith_ok = left == quot * right + rem
            rem_ok = 0 <= rem < abs(right)
            if uses_pair and arith_ok and rem_ok:
                pair = (right, rem)
                last_remainder = rem
                # The divisor is the gcd once the remainder is 0; a remainder that
                # already equals the gcd is the answer too.
                found = rem == goal or (rem == 0 and right == goal)
                return _Judged(StepCheck("valid"), answer=found)
            if uses_pair:
                pair = (right, rem)
                last_remainder = rem
                return _Judged(StepCheck("invalid", "division step is wrong",
                                         "Check the quotient and the remainder in this division step."))
            return _Judged(StepCheck("invalid", "division doesn't use the current remainder",
                                     "This division step doesn't continue the previous remainder."))
        cur = parse_statement(text)
        val = _expr_value(cur)
        if val is not None and getattr(val, "is_integer", False):
            number = int(val)
            if number == goal:
                return _Judged(StepCheck("valid"), cur, True)
            if last_remainder is not None and number == last_remainder:
                return _Judged(StepCheck("valid"), cur, number == goal)
            return _Judged(StepCheck("invalid", "not the gcd",
                                     "This isn't the greatest common divisor."), cur)
        return _Judged(StepCheck("unknown"), cur)

    walked = _walk(steps, judge)
    # A zero remainder is the signal the algorithm finished; the following line
    # naming the divisor is the answer. Also accept a bare correct gcd.
    return walked


def _parse_congruence(text: str) -> tuple[sp.Expr, int] | None:
    if " mod " not in text:
        return None
    left, modulus_text = text.rsplit(" mod ", 1)
    modulus = _as_int(modulus_text)
    if modulus is None or modulus <= 0 or modulus > 500 or "=" not in left:
        return None
    lhs_text, rhs_text = left.split("=", 1)
    try:
        lhs = parse_statement(lhs_text).lhs
        rhs = parse_statement(rhs_text).lhs
    except ParseError:
        return None
    if not isinstance(lhs, sp.Expr) or not isinstance(rhs, sp.Expr):
        return None
    return sp.expand(lhs - rhs), modulus


def _cong_solutions(expr: sp.Expr, modulus: int) -> list[int] | None:
    syms = list(expr.free_symbols)
    if len(syms) != 1:
        return None
    var = syms[0]
    found = []
    for residue in range(modulus):
        value = sp.simplify(expr.subs(var, residue))
        if not getattr(value, "is_integer", False):
            return None
        if int(value) % modulus == 0:
            found.append(residue)
    return found


def _solved_congruence(expr: sp.Expr) -> bool:
    syms = list(expr.free_symbols)
    if len(syms) != 1:
        return False
    poly = sp.Poly(sp.expand(expr), syms[0])
    if poly.degree() != 1:
        return False
    return poly.coeff_monomial(syms[0]) in (1, -1) and not poly.TC().free_symbols


def _check_congruence(problem: str, steps) -> dict | None:
    parsed = _parse_congruence(problem)
    if parsed is None:
        return None
    expr, modulus = parsed
    goal = _cong_solutions(expr, modulus)
    if goal is None:
        return None

    def judge(text: str, prev: Statement | None) -> _Judged:
        got = _parse_congruence(text)
        if got is None:
            return _Judged(StepCheck("unknown"))
        sols = _cong_solutions(got[0], got[1])
        if sols is None or got[1] != modulus:
            return _Judged(StepCheck("unknown"))
        if sols == goal:
            return _Judged(StepCheck("valid"), answer=_solved_congruence(got[0]))
        return _Judged(StepCheck("invalid", f"residues changed, modulus {modulus}",
                                 "This congruence doesn't have the same solutions as the line above."))

    return _walk(steps, judge)


# --------------------------------------------------------------------------
# Proofs, pigeonhole, chemistry
# --------------------------------------------------------------------------

def _strip_prove(problem: str) -> str:
    text = problem.strip()
    if text.lower().startswith("prove "):
        return text.split(None, 1)[1].strip()
    match = re.fullmatch(r"prove\((.*)\)", text, flags=re.I | re.S)
    if match:
        return match.group(1).strip()
    return text


def _goal_var(lhs: sp.Basic, rhs: sp.Basic) -> sp.Symbol | None:
    free = set(getattr(lhs, "free_symbols", ())) | set(getattr(rhs, "free_symbols", ()))
    for name in "nkmij":
        for sym in free:
            if str(sym) == name:
                return sym
    if len(free) == 1:
        return next(iter(free))
    return None


def _at(expr: sp.Basic, var: sp.Symbol, value: int) -> sp.Expr:
    done = expr.subs(var, value)
    if isinstance(done, (sp.Sum, sp.Integral)):
        done = done.doit()
    return done


def _matches_goal(stmt: Statement, lhs: sp.Expr, rhs: sp.Expr) -> bool:
    if stmt.kind != "eq" or stmt.rhs is None:
        return False
    return ((exprs_equal(stmt.lhs, lhs) is True and exprs_equal(stmt.rhs, rhs) is True)
            or (exprs_equal(stmt.lhs, rhs) is True and exprs_equal(stmt.rhs, lhs) is True))


def _is_structural_copy(stmt: Statement, lhs: sp.Expr, rhs: sp.Expr) -> bool:
    if stmt.kind != "eq" or stmt.rhs is None:
        return False
    return ((stmt.lhs == lhs and stmt.rhs == rhs) or (stmt.lhs == rhs and stmt.rhs == lhs))


def _inductive_step(stmt: Statement, sum_expr: sp.Sum | None, rhs: sp.Expr, var: sp.Symbol) -> bool:
    if sum_expr is None or stmt.kind != "eq" or stmt.rhs is None:
        return False
    term = sum_expr.function
    index = sum_expr.limits[0][0]
    candidates = {var} | set(stmt.lhs.free_symbols) | set(stmt.rhs.free_symbols)
    for symbol in candidates:
        closed = rhs.subs(var, symbol)
        added = term.subs(index, symbol + 1)
        left = sp.simplify(closed + added)
        right = sp.simplify(closed.subs(symbol, symbol + 1))
        if ((exprs_equal(stmt.lhs, left) is True and exprs_equal(stmt.rhs, right) is True)
                or (exprs_equal(stmt.lhs, right) is True and exprs_equal(stmt.rhs, left) is True)):
            return True
    return False


def check_prove(problem: str, steps, target: str | None) -> dict | None:
    try:
        goal = parse_statement(_strip_prove(problem))
    except ParseError:
        return None
    if goal.kind != "eq" or goal.rhs is None or not isinstance(goal.lhs, sp.Expr):
        return None
    lhs, rhs = goal.lhs, goal.rhs
    var = _goal_var(lhs, rhs)
    summation = lhs if isinstance(lhs, sp.Sum) else None
    if summation is not None and len(summation.limits[0]) == 3:
        base_default = summation.limits[0][1]
    else:
        base_default = 0 if var is None else 1

    results: dict[int, dict] = {}
    prev_expr: sp.Expr | None = None
    saw_base = False
    saw_step = False
    saw_real_proof = False
    any_bad = False
    expr_lines: list[sp.Expr] = []

    for line, text in steps:
        raw = str(text).strip()
        if not raw:
            results[line] = _row("unknown")
            prev_expr = None
            continue
        base = re.fullmatch(r"base\((\d+)\)", raw)
        if base and var is not None:
            try:
                holds = exprs_equal(_at(lhs, var, int(base.group(1))), _at(rhs, var, int(base.group(1)))) is True
            except Exception:
                holds = False
            if holds:
                saw_base = True
                results[line] = _row("valid")
            else:
                any_bad = True
                results[line] = _row("invalid", "base case is false", "The base case doesn't hold.")
            continue
        try:
            cur = parse_statement(raw)
        except ParseError as exc:
            results[line] = _row("unknown", str(exc))
            prev_expr = None
            continue
        if cur.kind == "expr" and isinstance(cur.lhs, sp.Expr):
            on_goal = exprs_equal(cur.lhs, lhs) is True or exprs_equal(cur.lhs, rhs) is True
            on_prev = prev_expr is not None and exprs_equal(cur.lhs, prev_expr) is True
            if on_goal or on_prev:
                results[line] = _row("valid")
                expr_lines.append(cur.lhs)
                prev_expr = cur.lhs
            else:
                any_bad = True
                results[line] = _row("invalid", "expression leaves the identity",
                                     "This isn't equal to either side of what you're proving.")
                prev_expr = cur.lhs
            continue
        if cur.kind == "eq" and isinstance(cur.lhs, sp.Expr) and isinstance(cur.rhs, sp.Expr):
            if exprs_equal(cur.lhs, cur.rhs) is not True:
                any_bad = True
                results[line] = _row("invalid", "claim is not true for every value",
                                     "This claim isn't true for every value of the variable.")
                continue
            results[line] = _row("valid")
            if var is not None:
                try:
                    base_value = int(base_default)
                    if (exprs_equal(cur.lhs, _at(lhs, var, base_value)) is True
                            and exprs_equal(cur.rhs, _at(rhs, var, base_value)) is True):
                        saw_base = True
                except Exception:
                    pass
            if _inductive_step(cur, summation, rhs, var) if var is not None else False:
                saw_step = True
            if _matches_goal(cur, lhs, rhs) and not _is_structural_copy(cur, lhs, rhs):
                saw_real_proof = True
            continue
        results[line] = _row("unknown")

    chain = False
    if len(expr_lines) >= 2 and not any_bad:
        covers_left = any(exprs_equal(expr, lhs) is True for expr in expr_lines)
        covers_right = any(exprs_equal(expr, rhs) is True for expr in expr_lines)
        chain = covers_left and covers_right
    arrived = not any_bad and (chain or saw_real_proof or (saw_base and saw_step))
    return {"results": results, "arrived": arrived}


def check_pigeonhole(problem: str, steps, target: str | None) -> dict | None:
    match = re.fullmatch(r"pigeonhole\((\d+),(\d+)\)", re.sub(r"\s+", "", problem), flags=re.I)
    if not match:
        return None
    items, boxes = int(match.group(1)), int(match.group(2))
    if boxes <= 0:
        return None
    need = (items + boxes - 1) // boxes

    def judge(text: str, prev: Statement | None) -> _Judged:
        cur = parse_statement(text)
        if cur.kind == "expr":
            if exprs_equal(cur.lhs, need) is True:
                return _Judged(StepCheck("valid"), cur, True)
            if getattr(cur.lhs, "is_integer", False):
                return _Judged(StepCheck("invalid", f"guaranteed minimum is {need}",
                                         "That isn't the number of items guaranteed to share a box."), cur)
        if cur.kind in ("eq", "ineq") and cur.rhs is not None and not cur.free:
            try:
                holds = bool(cur.relational())
            except TypeError:
                holds = False
            if holds:
                return _Judged(StepCheck("valid"), cur, False)
            return _Judged(StepCheck("invalid", "supporting claim is false",
                                     "That claim isn't true."), cur)
        return _Judged(StepCheck("unknown"), cur)

    return _walk(steps, judge)


_ELEMENT = re.compile(r"([A-Z][a-z]?)(\d*)")


def _atom_count(formula: str, mult: int = 1) -> dict[str, int]:
    counts: dict[str, int] = {}
    i = 0
    while i < len(formula):
        if formula[i] == "(":
            depth = 1
            j = i + 1
            while j < len(formula) and depth:
                depth += 1 if formula[j] == "(" else -1 if formula[j] == ")" else 0
                j += 1
            if depth != 0:
                raise ParseError(f"unbalanced parentheses in {formula!r}")
            inner = formula[i + 1:j - 1]
            k = j
            while k < len(formula) and formula[k].isdigit():
                k += 1
            group_mult = int(formula[j:k] or "1")
            for element, count in _atom_count(inner, mult * group_mult).items():
                counts[element] = counts.get(element, 0) + count
            i = k
            continue
        match = _ELEMENT.match(formula, i)
        if not match:
            raise ParseError(f"can't read formula {formula!r}")
        element, number = match.group(1), int(match.group(2) or "1")
        counts[element] = counts.get(element, 0) + mult * number
        i = match.end()
    return counts


def _split_terms(side: str) -> list[str]:
    parts: list[str] = []
    depth = 0
    buf: list[str] = []
    for ch in side:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "+" and depth == 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    parts.append("".join(buf))
    return [part.strip() for part in parts if part.strip()]


def _side_atoms(side: str) -> dict[str, int]:
    total: dict[str, int] = {}
    for term in _split_terms(side):
        match = re.fullmatch(r"(?:(\d+)\s*\*\s*|\b(\d+)\s+)?([A-Z][A-Za-z0-9()]*)", term.strip())
        if not match:
            raise ParseError(f"can't read term {term!r}")
        coef = int(match.group(1) or match.group(2) or "1")
        if coef <= 0:
            raise ParseError("coefficients have to be positive")
        for element, count in _atom_count(match.group(3)).items():
            total[element] = total.get(element, 0) + coef * count
    return total


def _balanced(text: str) -> bool:
    normalized = text.replace("->", "=").replace("→", "=")
    if normalized.count("=") != 1:
        raise ParseError("a chemical equation needs one '='")
    left, right = (part.strip() for part in normalized.split("="))
    return _side_atoms(left) == _side_atoms(right) and bool(_side_atoms(left))


def check_balance(problem: str, steps, target: str | None) -> dict | None:
    raw = problem.strip()
    if not (raw.lower().startswith("balance(") or raw.lower().startswith("balance ")):
        return None

    def judge(text: str, prev: Statement | None) -> _Judged:
        try:
            ok = _balanced(text)
        except ParseError as exc:
            return _Judged(StepCheck("unknown", str(exc)))
        if ok:
            return _Judged(StepCheck("valid"), answer=True)
        return _Judged(StepCheck("invalid", "atom counts differ",
                                 "The atoms on the two sides don't match."))

    return _walk(steps, judge)

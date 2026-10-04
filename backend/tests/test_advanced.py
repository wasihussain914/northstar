"""Step checking beyond algebra: trig, calculus, ODEs, matrices, discrete math."""

import pytest

from verify import check_steps, compare, parse_statement


def verdict(prev: str, cur: str, target: str | None = "x") -> str:
    from verify import _SYMBOLS
    return compare(parse_statement(prev), parse_statement(cur), _SYMBOLS.get(target)).verdict


def line_verdicts(problem: str, steps: list[str], target: str | None = None, task: str | None = None) -> dict:
    numbered = [(i + 1, text) for i, text in enumerate(steps)]
    out = check_steps(problem, numbered, target, task)
    return {n: out["results"][n]["verdict"] for n in out["results"]}, out["arrived"]


# --- algebra 2 and trig, on the existing expression checker --------------

@pytest.mark.parametrize("prev,cur", [
    ("sin(x)^2 + cos(x)^2", "1"),
    ("1 - cos(x)^2", "sin(x)^2"),
    ("sec(x)", "1/cos(x)"),
    ("log(x) + log(y)", "log(x*y)"),
    ("(x^2 - 1)/(x - 1)", "x + 1"),
    ("factorial(n+1)/factorial(n)", "n + 1"),
    ("binomial(n, 2)", "n*(n-1)/2"),
])
def test_identities(prev, cur):
    assert verdict(prev, cur, None) == "valid"


def test_false_trig_identity_is_invalid():
    assert verdict("sin(x)^2 + cos(x)^2", "2", None) == "invalid"


# --- calculus -------------------------------------------------------------

def test_derivative_accepts_the_answer_and_rejects_a_power_rule_mistake():
    good, arrived = line_verdicts("diff(x^2*sin(x), x)", ["2*x*sin(x) + x^2*cos(x)"])
    assert good == {1: "valid"} and arrived
    bad, arrived = line_verdicts("diff(x^2, x)", ["3*x"])
    assert bad == {1: "invalid"} and not arrived
    note = check_steps("diff(x^2, x)", [(1, "3*x")], "x")["results"][1]["note"]
    assert note and "2" not in note


def test_derivative_allows_the_original_function_then_the_result():
    verdicts, arrived = line_verdicts("diff(x^3, x, 2)", ["x^3", "3*x^2", "6*x"])
    assert verdicts == {1: "valid", 2: "valid", 3: "valid"} and arrived


def test_partial_and_gradient():
    partial, arrived = line_verdicts("diff(x^2*y + sin(x*y), x)", ["2*x*y + y*cos(x*y)"])
    assert partial == {1: "valid"} and arrived
    grad, arrived = line_verdicts("grad(x^2 + y^2, x, y)", ["[[2*x], [2*y]]"])
    assert grad == {1: "valid"} and arrived


def test_bare_expression_with_an_explicit_differentiate_task():
    verdicts, arrived = line_verdicts("x^2*sin(x)", ["2*x*sin(x) + x^2*cos(x)"], "x", "differentiate")
    assert verdicts == {1: "valid"} and arrived


def test_indefinite_integral_accepts_a_constant_and_rejects_a_wrong_antiderivative():
    good, arrived = line_verdicts("integrate(x*exp(x), x)", ["x*exp(x) - exp(x) + C"])
    assert good == {1: "valid"} and arrived
    bad, _ = line_verdicts("integrate(x^2, x)", ["x^3/2"])
    assert bad == {1: "invalid"}


def test_definite_integral_and_a_limit():
    integral, arrived = line_verdicts("integrate(x^2, x, 0, 2)", ["x^3/3", "8/3"])
    assert integral == {1: "valid", 2: "valid"} and arrived
    limit, arrived = line_verdicts("limit((x^2 - 1)/(x - 1), x, 1)", ["x + 1", "2"])
    assert limit == {1: "valid", 2: "valid"} and arrived
    wrong, arrived = line_verdicts("limit((x^2 - 1)/(x - 1), x, 1)", ["0"])
    assert wrong == {1: "invalid"} and not arrived


def test_right_hand_limit():
    verdicts, arrived = line_verdicts("limright(1/x, x, 0)", ["oo"])
    assert verdicts == {1: "valid"} and arrived


# --- differential equations and a physics ODE -----------------------------

def test_ode_general_solution_particular_solution_and_a_wrong_one():
    good, arrived = line_verdicts(
        "diff(y(x), x, 2) + y(x) = 0",
        ["y(x) = C1*sin(x) + C2*cos(x)"],
    )
    assert good == {1: "valid"} and arrived

    particular = check_steps("diff(y(x), x, 2) + y(x) = 0", [(1, "y(x) = sin(x)")], None)
    assert particular["results"][1]["verdict"] == "caution"
    assert particular["arrived"] is False
    assert "constant" in particular["results"][1]["note"]

    bad, _ = line_verdicts("diff(y(x), x, 2) + y(x) = 0", ["y(x) = x"])
    assert bad == {1: "invalid"}


def test_ode_initial_condition_and_constant_acceleration():
    ivp, arrived = line_verdicts(
        "diff(y(x), x) = 2*y(x); y(0) = 3",
        ["y(x) = 3*exp(2*x)"],
    )
    assert ivp == {1: "valid"} and arrived

    motion, arrived = line_verdicts(
        "diff(x(t), t, 2) = -10",
        ["x(t) = -5*t^2 + C1*t + C2"],
        task="physics",
    )
    assert motion == {1: "valid"} and arrived


def test_heat_equation_and_laplace_equation():
    heat, arrived = line_verdicts(
        "diff(u(x, t), t) = diff(u(x, t), x, 2)",
        ["u(x, t) = exp(-t)*sin(x)"],
    )
    assert heat == {1: "valid"} and arrived
    wrong, _ = line_verdicts(
        "diff(u(x, t), t) = diff(u(x, t), x, 2)",
        ["u(x, t) = exp(t)*sin(x)"],
    )
    assert wrong == {1: "invalid"}

    laplace, arrived = line_verdicts(
        "diff(u(x, y), x, 2) + diff(u(x, y), y, 2) = 0",
        ["u(x, y) = exp(x)*cos(y)"],
    )
    assert laplace == {1: "valid"} and arrived


# --- linear algebra -------------------------------------------------------

def test_row_reduction_keeps_only_equivalent_steps():
    verdicts, arrived = line_verdicts(
        "[[2, 1, 5], [1, -1, 1]]",
        ["[[1, -1, 1], [2, 1, 5]]", "[[1, -1, 1], [0, 3, 3]]", "[[1, 0, 2], [0, 1, 1]]"],
    )
    assert verdicts == {1: "valid", 2: "valid", 3: "valid"} and arrived

    bad, arrived = line_verdicts(
        "[[2, 1, 5], [1, -1, 1]]",
        ["[[1, -1, 1], [0, 3, 4]]"],
    )
    assert bad == {1: "invalid"} and not arrived


def test_determinant_and_inverse():
    det, arrived = line_verdicts("det([[1, 2], [3, 4]])", ["1*4 - 2*3", "-2"])
    assert det == {1: "valid", 2: "valid"} and arrived
    inv, arrived = line_verdicts("inv([[1, 2], [3, 4]])", ["[[-2, 1], [3/2, -1/2]]"])
    assert inv == {1: "valid"} and arrived


# --- discrete math --------------------------------------------------------

def test_closed_form_of_a_sum():
    verdicts, arrived = line_verdicts("summation(k, k, 1, n)", ["n*(n+1)/2"])
    assert verdicts == {1: "valid"} and arrived


def test_euclid_and_a_bad_remainder():
    verdicts, arrived = line_verdicts(
        "gcd(48, 18)",
        ["48 = 2*18 + 12", "18 = 1*12 + 6", "12 = 2*6 + 0", "6"],
    )
    assert verdicts == {1: "valid", 2: "valid", 3: "valid", 4: "valid"} and arrived

    bad, arrived = line_verdicts("gcd(48, 18)", ["48 = 2*18 + 10"])
    assert bad == {1: "invalid"} and not arrived
    note = check_steps("gcd(48, 18)", [(1, "48 = 2*18 + 10")], None)["results"][1]["note"]
    assert note and "6" not in note


def test_linear_congruence_and_modular_inverse():
    good, arrived = line_verdicts("3*x = 1 mod 7", ["x = 5 mod 7"])
    assert good == {1: "valid"} and arrived
    bad, _ = line_verdicts("3*x = 1 mod 7", ["x = 3 mod 7"])
    assert bad == {1: "invalid"}
    inv, arrived = line_verdicts("modinv(3, 7)", ["5"])
    assert inv == {1: "valid"} and arrived
    mod, arrived = line_verdicts("Mod(17, 5)", ["2"])
    assert mod == {1: "valid"} and arrived


def test_direct_proof_and_a_false_claim():
    verdicts, arrived = line_verdicts("prove n^2 + n = n*(n+1)", ["n^2 + n", "n*(n + 1)"])
    assert verdicts == {1: "valid", 2: "valid"} and arrived

    copied, arrived = line_verdicts("prove n^2 + n = n*(n+1)", ["n^2 + n = n*(n+1)"])
    assert copied == {1: "valid"} and not arrived

    false, arrived = line_verdicts("prove n^2 + n = n*(n+1)", ["n^2 + n = n^2 + 1"])
    assert false == {1: "invalid"} and not arrived


def test_induction_for_the_sum_formula():
    verdicts, arrived = line_verdicts(
        "prove summation(k, k, 1, n) = n*(n+1)/2",
        ["base(1)", "n*(n+1)/2 + (n+1) = (n+1)*(n+2)/2"],
    )
    assert verdicts == {1: "valid", 2: "valid"} and arrived


def test_pigeonhole():
    verdicts, arrived = line_verdicts("pigeonhole(13, 12)", ["13 > 12", "2"])
    assert verdicts == {1: "valid", 2: "valid"} and arrived
    bad, arrived = line_verdicts("pigeonhole(13, 12)", ["1"])
    assert bad == {1: "invalid"} and not arrived
    note = check_steps("pigeonhole(13, 12)", [(1, "1")], None)["results"][1]["note"]
    assert note and "2" not in note


def test_balancing_a_chemical_equation():
    good, arrived = line_verdicts("balance(H2 + O2 = H2O)", ["2*H2 + O2 = 2*H2O"])
    assert good == {1: "valid"} and arrived
    acid, arrived = line_verdicts(
        "balance(Ca(OH)2 + HCl = CaCl2 + H2O)",
        ["Ca(OH)2 + 2*HCl = CaCl2 + 2*H2O"],
    )
    assert acid == {1: "valid"} and arrived
    bad, _ = line_verdicts("balance(H2 + O2 = H2O)", ["H2 + O2 = H2O"])
    assert bad == {1: "invalid"}


def test_matrix_injection_is_still_rejected():
    from verify import ParseError
    with pytest.raises(ParseError):
        parse_statement("[x for x in range(3)]")
    with pytest.raises(ParseError):
        parse_statement("Matrix(__import__('os'))")


# --- integration by parts / substitution bookkeeping ----------------------

def test_by_parts_bookkeeping_is_verified():
    # The full classic layout: picks are definitions, differentials are provable.
    good, arrived = line_verdicts(
        "integrate(x^2*exp(x), x)",
        ["u = x^2", "du = 2*x*dx", "dv = exp(x)*dx", "v = exp(x)",
         "x^2*exp(x) - 2*x*exp(x) + 2*exp(x) + C"])
    assert good == {1: "valid", 2: "valid", 3: "valid", 4: "valid", 5: "valid"}
    assert arrived


def test_wrong_differential_is_flagged():
    bad, arrived = line_verdicts("integrate(x^2*exp(x), x)", ["u = x^2", "du = x*dx"])
    assert bad == {1: "valid", 2: "invalid"} and not arrived
    # Forgetting the dx reads as "du = 2x", which isn't a differential in x at
    # all — that stays unknown (AI judges it) rather than falsely flagged.
    unk, _ = line_verdicts("integrate(x^2*exp(x), x)", ["u = x^2", "du = 2*x"])
    assert unk[2] == "unknown"


def test_differential_forms_spaced_and_slash():
    ok, _ = line_verdicts("integrate(2*x*cos(x^2), x)", ["u = x^2", "du = 2x dx"])
    assert ok == {1: "valid", 2: "valid"}
    ok, _ = line_verdicts("integrate(2*x*cos(x^2), x)", ["u = x^2", "du/dx = 2*x"])
    assert ok == {1: "valid", 2: "valid"}

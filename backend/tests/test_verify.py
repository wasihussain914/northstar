import pytest

from verify import ParseError, check_steps, compare, parse_statement


def verdict(prev: str, cur: str, target: str | None = "x") -> str:
    from verify import _SYMBOLS
    return compare(parse_statement(prev), parse_statement(cur), _SYMBOLS.get(target)).verdict


# --- correct moves -------------------------------------------------------

@pytest.mark.parametrize("prev,cur", [
    ("2(x-3)+4 = 10", "2x - 6 + 4 = 10"),      # distribute
    ("2x - 6 + 4 = 10", "2x - 2 = 10"),         # combine like terms
    ("2x - 2 = 10", "2x = 12"),                 # add to both sides
    ("2x = 12", "x = 6"),                       # divide
    ("x/3 + 1 = 5", "x + 3 = 15"),              # multiply through
    ("x^2 - 5x + 6 = 0", "(x-2)(x-3) = 0"),     # factor
    ("3(x+2) - x", "2x + 6"),                   # simplify an expression
    ("-2x + 4 > 10", "-2x > 6"),                # inequality, no flip needed
    ("-2x > 6", "x < -3"),                      # divide by negative, flipped
    ("12 = 2x", "6 = x"),                       # solved on the right
])
def test_valid_steps(prev, cur):
    assert verdict(prev, cur) == "valid"


# --- classic wrong turns -------------------------------------------------

@pytest.mark.parametrize("prev,cur", [
    ("2(x-3)+4 = 10", "2x - 3 + 4 = 10"),      # didn't distribute to second term
    ("-2(x-3) = 8", "-2x - 6 = 8"),             # sign error distributing a negative
    ("2x - 2 = 10", "2x = 8"),                  # subtracted instead of added
    ("-2x > 6", "x > -3"),                      # forgot to flip the inequality
    ("x^2 = 9", "x = 3"),                       # lost the negative root
    ("3(x+2) - x", "2x + 2"),                   # expression simplified wrong
    ("x/3 + 1 = 5", "x + 1 = 15"),              # multiplied only one term
])
def test_invalid_steps(prev, cur):
    assert verdict(prev, cur) == "invalid"


def test_squaring_adds_extraneous_solution_is_caution():
    assert verdict("sqrt(x) = -2", "x = 4") == "caution"


def test_multivariable_solve_for_target():
    assert verdict("2y + 4x = 8", "y = 4 - 2x", "y") == "valid"
    assert verdict("2y + 4x = 8", "y = 8 - 2x", "y") == "invalid"


# --- whole board ---------------------------------------------------------

def test_board_finds_first_error_and_arrival():
    steps = [(1, "2x - 6 + 4 = 10"), (2, "2x + 2 = 10"), (3, "2x = 8"), (4, "x = 4")]
    out = check_steps("2(x-3)+4 = 10", steps, "x")
    verdicts = {line: r["verdict"] for line, r in out["results"].items()}
    assert verdicts == {1: "valid", 2: "invalid", 3: "valid", 4: "valid"}
    assert out["arrived"] is False


def test_board_arrives_at_destination():
    steps = [(1, "2x - 2 = 10"), (2, "2x = 12"), (4, "x = 6")]
    out = check_steps("2(x-3)+4 = 10", steps, "x")
    assert all(r["verdict"] == "valid" for r in out["results"].values())
    assert out["arrived"] is True


def test_unreadable_line_breaks_the_chain_without_crashing():
    out = check_steps("2x = 12", [(1, ""), (2, "x = 6")], "x")
    assert out["results"][1]["verdict"] == "unknown"
    assert out["results"][2]["verdict"] == "valid"


# --- untrusted input -----------------------------------------------------

@pytest.mark.parametrize("bad", [
    "__import__('os').system('echo hi')",
    "x.__class__",
    "eval(1)",
    "lambda: 1",
    "[x for x in range(3)]",
    "open(1)",
])
def test_rejects_code(bad):
    with pytest.raises(ParseError):
        parse_statement(bad)


def test_an_explicit_root_list_is_solved_form_and_can_arrive():
    out = check_steps("x^2 = 5x", [(1, "x^2 - 5x = 0"), (2, "x*(x - 5) = 0"), (3, "x = 0 or x = 5")], "x")
    assert all(r["verdict"] == "valid" for r in out["results"].values())
    assert out["arrived"] is True
    # A wrong root list neither passes nor arrives.
    out = check_steps("x^2 = 5x", [(1, "x^2 - 5x = 0"), (2, "x = 0 or x = 4")], "x")
    assert out["results"][2]["verdict"] == "invalid" and out["arrived"] is False


def test_dividing_by_x_loses_the_zero_root():
    out = check_steps("x^2 = 5x", [(1, "x^2 = 5x"), (2, "x = 5")], "x")
    assert out["results"][2]["verdict"] == "invalid"
    assert "loses" in out["results"][2]["detail"]

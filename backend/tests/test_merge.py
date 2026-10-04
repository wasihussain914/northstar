from main import SKIP_KINDS, merge


def line(n, sympy, kind="equation", ai="ok"):
    return {"line": n, "latex": sympy, "sympy": sympy, "kind": kind, "ai_verdict": ai}


def test_sympy_overrides_claude_and_ai_fills_gaps():
    board = {"lines": [
        line(1, "2*x - 6 + 4 = 10"),
        line(2, "2*x + 2 = 10", ai="ok"),       # Claude missed it; SymPy catches it
        line(3, "", kind="not_math"),
        line(4, "2*x = 8", ai="unclear"),
        line(5, "", kind="incomplete"),
    ]}
    sym = {"results": {1: {"verdict": "valid", "detail": "", "note": ""},
                       2: {"verdict": "invalid", "detail": "solutions changed from 6 to 4",
                           "note": "This line has different solutions than the line above."},
                       4: {"verdict": "unknown", "detail": "", "note": ""}}}
    merged = merge(board, sym)
    out = {l["line"]: (l["status"], l["source"]) for l in merged}
    assert out == {1: ("ok", "verified"), 2: ("error", "verified"), 3: ("skip", "ai"),
                   4: ("unclear", "ai"), 5: ("pending", "ai")}
    # The student-facing detail never contains solution values.
    assert merged[1]["detail"] == "This line has different solutions than the line above."
    assert merged[1]["_detail"] == "solutions changed from 6 to 4"


def test_student_facing_notes_never_contain_the_answer():
    from verify import check_steps
    out = check_steps("2(x-3)+4 = 10", [(1, "2x - 6 + 4 = 10"), (2, "2x + 2 = 10")], "x")
    note = out["results"][2]["note"]
    assert note and "6" not in note and "4" not in note


def test_reference_formulas_are_not_wrong_turns():
    board = {"lines": [
        line(1, "x = (-b + sqrt(b^2 - 4*a*c))/(2*a)", kind="formula", ai="ok"),
        line(2, "x = p*sin(f)*cos(t)", kind="formula", ai="unclear"),
        line(3, "x = (-b + sqrt(b^2 + 4*a*c))/(2*a)", kind="formula", ai="error"),
    ]}
    out = {l["line"]: l["status"] for l in merge(board, None)}
    assert out == {1: "skip", 2: "skip", 3: "error"}


def test_steps_chain_past_a_formula_line():
    from verify import check_steps
    board = [line(1, "x = (-b + sqrt(b^2 - 4*a*c))/(2*a)", kind="formula"), line(2, "(x - 2)*(x - 3) = 0")]
    steps = [(l["line"], l["sympy"]) for l in board if l["kind"] not in SKIP_KINDS]
    out = check_steps("x^2 - 5*x + 6 = 0", steps, "x")
    assert list(out["results"]) == [2]
    assert out["results"][2]["verdict"] == "valid"


def test_without_sympy_uses_claude_verdicts():
    board = {"lines": [line(1, "x = 2", ai="error")]}
    assert merge(board, None)[0]["status"] == "error"


def test_intermediate_work_ignores_adjacent_mismatch_but_keeps_actual_errors():
    board = {"lines": [
        line(1, "y(x) = C1*exp(2*x)", kind="intermediate"),
        line(2, "C1 = 3", kind="intermediate", ai="unclear"),
        line(3, "y(x) = C1*exp(3*x)", kind="intermediate", ai="error"),
    ]}
    sym = {"results": {1: {"verdict": "invalid", "detail": "adjacent mismatch", "note": ""}}}
    assert [(l["status"], l["source"]) for l in merge(board, sym)] == [
        ("skip", "ai"), ("skip", "ai"), ("error", "ai"),
    ]

"""Route preview: /api/plan judges the student's spoken plan without solving."""

import asyncio

from main import PlanRequest, plan
from tutor import PLAN_RULES, PLAN_SCHEMA


def test_plan_rules_never_solve():
    assert "Never state the final answer" in PLAN_RULES
    assert set(PLAN_SCHEMA["required"]) == {"verdict", "feedback", "spoken"}
    assert PLAN_SCHEMA["properties"]["verdict"]["enum"] == ["good", "partial", "off"]


def test_endpoint_judges_plans_in_fake_mode(monkeypatch):
    import main
    monkeypatch.setattr(main, "FAKE_VISION", True)

    def ask(text):
        return asyncio.run(plan(PlanRequest(problem="Solve 2(x - 3) + 4 = 10", plan=text)))

    assert ask("distribute the 2, combine like terms, isolate x")["verdict"] == "good"
    assert ask("combine like terms then divide both sides")["verdict"] == "partial"
    assert ask("guess numbers until one works")["verdict"] == "off"
    out = ask("distribute then isolate")
    assert out["feedback"] and out["spoken"]

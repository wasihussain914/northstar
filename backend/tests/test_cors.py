"""CORS origins always include localhost; LAN IP is opt-in."""

from __future__ import annotations

import pytest

import main


def test_cors_defaults_to_localhost(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LOCAL_IP", raising=False)
    monkeypatch.delenv("FRONTEND_PORT", raising=False)
    assert main.cors_origins() == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


def test_cors_empty_local_ip_stays_localhost(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOCAL_IP", "  ")
    monkeypatch.delenv("FRONTEND_PORT", raising=False)
    assert "http://localhost:5173" in main.cors_origins()
    assert len(main.cors_origins()) == 2


def test_cors_appends_lan_origin(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOCAL_IP", "192.168.1.42")
    monkeypatch.setenv("FRONTEND_PORT", "5173")
    origins = main.cors_origins()
    assert origins[:2] == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]
    assert origins[-1] == "http://192.168.1.42:5173"

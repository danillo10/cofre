from __future__ import annotations

from datetime import date, timedelta
from typing import Any


def brl(cents: int) -> str:
    value = f"{cents / 100:,.2f}".replace(",", "_").replace(".", ",").replace("_", ".")
    return f"R$ {value}"


def _spent(rows: list[dict[str, Any]], start: date, end: date) -> int:
    return sum(
        row["amount_cents"]
        for row in rows
        if row["kind"] == "expense"
        and start.isoformat() <= row["occurred_on"] <= end.isoformat()
    )


def _band(score: int) -> tuple[str, str]:
    if score >= 70:
        return "Controlado", "ok"
    if score >= 45:
        return "Apertando", "warn"
    return "Ruim", "bad"


def build_situation(
    today: date,
    income: int,
    expense: int,
    budgets: list[dict[str, Any]],
    cards: list[dict[str, Any]],
    rows: list[dict[str, Any]],
) -> dict[str, Any]:
    if budgets:
        worst_budget = max(budgets, key=lambda item: item["ratio"])
        ratio = worst_budget["ratio"]
        budget_score = round(100 - ratio * 25) if ratio <= .8 else (
            round(80 - (ratio - .8) * 200) if ratio <= 1 else max(0, round(40 - (ratio - 1) * 90))
        )
        detail = (
            f'{worst_budget["label"]} estourou o teto: '
            f'{brl(worst_budget["spentCents"])} de {brl(worst_budget["limitCents"])}.'
            if ratio >= 1
            else f'Os tetos ainda têm folga; maior uso: {worst_budget["label"]}.'
        )
    else:
        budget_score, detail = 70, "Defina um teto para eu medir as categorias."
    budget_word, budget_tone = _band(budget_score)

    if cards:
        worst_card = max(cards, key=lambda item: item["ratio"])
        credit_score = max(0, round(100 - worst_card["ratio"] * 100))
        credit_detail = (
            f'{worst_card["name"]} comprometeu {round(worst_card["ratio"] * 100)}% do limite.'
        )
    else:
        credit_score, credit_detail = 80, "Nenhum cartão cadastrado."
    credit_word, credit_tone = _band(credit_score)

    month_days = (date(today.year + (today.month == 12), today.month % 12 + 1, 1) - date(today.year, today.month, 1)).days
    progress = today.day / month_days
    pace = expense / income / progress if income else None
    pace_score = 60 if pace is None else (92 if pace <= .85 else 74 if pace <= 1 else 48 if pace <= 1.2 else 22)
    pace_word, pace_tone = _band(pace_score)
    pace_detail = f"Entrou {brl(income)} e saiu {brl(expense)}." if income else "Lance uma receita para eu medir o ritmo."

    factors = [
        {"id": "tetos", "label": "Tetos", "score": budget_score, "word": budget_word, "tone": budget_tone, "detail": detail},
        {"id": "credito", "label": "Crédito", "score": credit_score, "word": credit_word, "tone": credit_tone, "detail": credit_detail},
        {"id": "ritmo", "label": "Ritmo", "score": pace_score, "word": pace_word, "tone": pace_tone, "detail": pace_detail},
    ]
    worst = min(factors, key=lambda item: item["score"])
    recent = _spent(rows, today - timedelta(days=6), today)
    prior = _spent(rows, today - timedelta(days=13), today - timedelta(days=7))
    trend = "piorando" if prior and recent > prior * 1.15 else "melhorando" if prior and recent < prior * .85 else "estavel"
    has_movement = any(row["kind"] in {"expense", "income"} for row in rows)
    headline = "Sem lançamentos" if not has_movement else (
        "Fora de controle" if worst["score"] < 45 else "Piorando" if trend == "piorando" else "Apertando" if worst["score"] < 70 else "Sob controle"
    )
    tone = "ok" if not has_movement else "bad" if worst["score"] < 45 else "warn" if worst["score"] < 70 or trend == "piorando" else "ok"
    monday = today - timedelta(days=today.weekday())
    weeks = []
    for offset in (3, 2, 1, 0):
        start = monday - timedelta(days=7 * offset)
        weeks.append({"label": start.strftime("%d/%m"), "cents": _spent(rows, start, start + timedelta(days=6))})
    summary = "Manda um gasto ou uma receita para eu começar a medir." if not has_movement else f'{worst["detail"]} A semana soma {brl(recent)}.'
    return {
        "score": worst["score"], "headline": headline, "tone": tone, "trend": trend,
        "summary": summary, "recentCents": recent, "priorCents": prior,
        "factors": factors, "weeks": weeks,
    }


def format_situation(value: dict[str, Any]) -> str:
    lines = [f'{value["headline"]} · {value["score"]}/100', value["summary"], ""]
    for factor in value["factors"]:
        filled = max(0, min(10, round(factor["score"] / 10)))
        lines.append(f'{factor["label"]:<8} {"█" * filled}{"░" * (10 - filled)} {factor["word"]}')
    return "\n".join(lines)

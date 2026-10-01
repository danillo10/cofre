from __future__ import annotations

import re
import unicodedata
from calendar import monthrange
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any
from zoneinfo import ZoneInfo

from .db import Database
from .situation import brl, build_situation

EXPENSE_CATEGORIES = [
    ("alimentacao", "Alimentação"), ("mercado", "Mercado"), ("transporte", "Transporte"),
    ("moradia", "Moradia"), ("lazer", "Lazer"), ("saude", "Saúde"),
    ("assinaturas", "Assinaturas"), ("educacao", "Educação"), ("outros", "Outros"),
]
INCOME_CATEGORIES = [("salario", "Salário"), ("freelance", "Freelance"), ("outros", "Outros")]
TIMEZONE = ZoneInfo("America/Sao_Paulo")


def local_today() -> date:
    return datetime.now(TIMEZONE).date()


def normalize_category(value: Any) -> str:
    text = unicodedata.normalize("NFD", str(value or "")).encode("ascii", "ignore").decode().lower()
    result = re.sub(r"[^a-z0-9]+", "_", text.strip()).strip("_")
    if not 2 <= len(result) <= 40:
        raise ValueError("Categoria inválida")
    return result


def category_label(kind: str, category: str) -> str:
    entries = INCOME_CATEGORIES if kind == "income" else EXPENSE_CATEGORIES
    return dict(entries).get(category, category.replace("_", " ").title())


def to_cents(value: Any) -> int:
    if isinstance(value, int | float):
        number = Decimal(str(value))
    else:
        text = re.sub(r"\s+", "", str(value or "")).removeprefix("R$").removeprefix("r$")
        if "," in text and "." in text:
            text = text.replace(".", "").replace(",", ".") if text.rfind(",") > text.rfind(".") else text.replace(",", "")
        elif "," in text:
            text = text.replace(",", ".")
        try:
            number = Decimal(text)
        except InvalidOperation as error:
            raise ValueError("Valor inválido") from error
    cents = int((number * 100).quantize(Decimal("1")))
    if cents <= 0 or cents > 100_000_000:
        raise ValueError("Valor inválido")
    return cents


def valid_date(value: Any) -> str:
    try:
        return date.fromisoformat(str(value)).isoformat()
    except ValueError as error:
        raise ValueError("Data inválida") from error


def add_months(day: str, offset: int) -> str:
    current = date.fromisoformat(day)
    index = current.year * 12 + current.month - 1 + offset
    year, month_index = divmod(index, 12)
    month = month_index + 1
    return date(year, month, min(current.day, monthrange(year, month)[1])).isoformat()


class Cofre:
    def __init__(self, database: Database | None = None) -> None:
        self.database = database or Database()

    def setting(self, key: str, fallback: str | None = None) -> str | None:
        with self.database.connect() as connection:
            row = connection.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
            return row["value"] if row else fallback

    def put_setting(self, key: str, value: Any) -> None:
        with self.database.connect() as connection:
            connection.execute(
                "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, str(value)),
            )

    def claim_update(self, update_id: int) -> bool:
        try:
            with self.database.connect() as connection:
                connection.execute("INSERT INTO telegram_updates(update_id) VALUES(?)", (update_id,))
            return True
        except Exception:
            return False

    def add_message(self, chat_id: str, role: str, content: str) -> None:
        if role not in {"user", "assistant"} or not str(content).strip():
            return
        with self.database.connect() as connection:
            connection.execute(
                "INSERT INTO conversation_messages(chat_id,role,content,created_at) VALUES(?,?,?,?)",
                (str(chat_id), role, str(content).strip(), datetime.now(timezone.utc).isoformat()),
            )
            connection.execute(
                """DELETE FROM conversation_messages WHERE chat_id=? AND id NOT IN
                   (SELECT id FROM conversation_messages WHERE chat_id=? ORDER BY id DESC LIMIT 50)""",
                (str(chat_id), str(chat_id)),
            )

    def history(self, chat_id: str, limit: int = 20) -> list[dict[str, str]]:
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT role,content FROM conversation_messages WHERE chat_id=? ORDER BY id DESC LIMIT ?",
                (str(chat_id), max(1, min(50, limit))),
            ).fetchall()
        return [dict(row) for row in reversed(rows)]

    def _card(self, connection: Any, value: Any) -> Any:
        if value in (None, ""):
            return None
        query = "SELECT * FROM cards WHERE id=?" if str(value).isdigit() else "SELECT * FROM cards WHERE name=? COLLATE NOCASE"
        row = connection.execute(query, (value,)).fetchone()
        if not row:
            raise ValueError("Cartão não encontrado")
        return row

    def add_card(self, data: dict[str, Any]) -> int:
        name = " ".join(str(data.get("name", "")).split())
        if not 2 <= len(name) <= 40:
            raise ValueError("O nome do cartão precisa ter entre 2 e 40 caracteres")
        close, due = int(data.get("closeDay", 0)), int(data.get("dueDay", 0))
        if not 1 <= close <= 28 or not 1 <= due <= 28:
            raise ValueError("Fechamento e vencimento precisam estar entre 1 e 28")
        try:
            with self.database.connect() as connection:
                cursor = connection.execute(
                    "INSERT INTO cards(name,limit_cents,close_day,due_day) VALUES(?,?,?,?)",
                    (name, to_cents(data.get("limit")), close, due),
                )
                return int(cursor.lastrowid)
        except Exception as error:
            if "UNIQUE" in str(error):
                raise ValueError("Já existe um cartão com esse nome") from error
            raise

    def update_card(self, card_id: int, data: dict[str, Any]) -> None:
        with self.database.connect() as connection:
            row = self._card(connection, card_id)
            name = " ".join(str(data.get("name", row["name"])).split())
            limit_cents = to_cents(data["limit"]) if "limit" in data else row["limit_cents"]
            close, due = int(data.get("closeDay", row["close_day"])), int(data.get("dueDay", row["due_day"]))
            if not 2 <= len(name) <= 40 or not 1 <= close <= 28 or not 1 <= due <= 28:
                raise ValueError("Dados do cartão inválidos")
            connection.execute(
                "UPDATE cards SET name=?,limit_cents=?,close_day=?,due_day=? WHERE id=?",
                (name, limit_cents, close, due, card_id),
            )

    def delete_card(self, card_id: int) -> None:
        with self.database.connect() as connection:
            row = self._card(connection, card_id)
            used = connection.execute("SELECT 1 FROM transactions WHERE card_id=? LIMIT 1", (row["id"],)).fetchone()
            if used:
                raise ValueError("Não é possível excluir um cartão com lançamentos")
            connection.execute("DELETE FROM cards WHERE id=?", (row["id"],))

    def set_budget(self, category: str, limit: Any) -> None:
        key = normalize_category(category)
        with self.database.connect() as connection:
            connection.execute(
                "INSERT INTO budgets(category,limit_cents) VALUES(?,?) ON CONFLICT(category) DO UPDATE SET limit_cents=excluded.limit_cents",
                (key, to_cents(limit)),
            )

    def delete_budget(self, category: str) -> None:
        with self.database.connect() as connection:
            connection.execute("DELETE FROM budgets WHERE category=?", (normalize_category(category),))

    def _resolve_category(self, connection: Any, kind: str, category: Any) -> str:
        if kind == "card_payment":
            return "pagamento_cartao"
        key = normalize_category(category)
        allowed = dict(INCOME_CATEGORIES if kind == "income" else EXPENSE_CATEGORIES)
        if key not in allowed and not (
            kind == "expense"
            and connection.execute("SELECT 1 FROM budgets WHERE category=?", (key,)).fetchone()
        ):
            raise ValueError("Categoria inválida")
        return key

    def add_transaction(self, data: dict[str, Any]) -> int:
        kind = data.get("kind")
        if kind not in {"expense", "income", "card_payment"}:
            raise ValueError("Tipo de lançamento inválido")
        cents = int(data["amountCents"]) if data.get("amountCents") is not None else to_cents(data.get("amount"))
        if cents <= 0 or cents > 100_000_000:
            raise ValueError("Valor inválido")
        count = max(1, min(60, int(data.get("installmentCount") or 1))) if kind == "expense" else 1
        today = local_today()
        occurred = valid_date(data.get("date") or today)
        ids: list[int] = []
        with self.database.transaction() as connection:
            category = self._resolve_category(connection, kind, data.get("category"))
            card = None if kind == "income" else self._card(connection, data.get("card"))
            if kind == "card_payment" and not card:
                raise ValueError("Pagamento precisa de um cartão")
            if kind == "card_payment" and cents > card["balance_cents"]:
                raise ValueError("O pagamento é maior do que a fatura em aberto")
            base, remainder = divmod(cents, count)
            for index in range(count):
                amount = base + (1 if index < remainder else 0)
                note = str(data.get("note") or "").strip()
                if count > 1:
                    note = f"{note or 'Compra'} · parcela {index + 1}/{count}"
                cursor = connection.execute(
                    """INSERT INTO transactions
                       (occurred_on,logged_on,amount_cents,kind,category,card_id,note,created_at,source,raw_text)
                       VALUES(?,?,?,?,?,?,?,?,?,?)""",
                    (
                        add_months(occurred, index), today.isoformat(), amount, kind, category,
                        card["id"] if card else None, note, datetime.now(timezone.utc).isoformat(),
                        data.get("source", "painel") if data.get("source") in {"painel", "telegram", "demo"} else "painel",
                        str(data.get("rawText") or ""),
                    ),
                )
                ids.append(int(cursor.lastrowid))
            if card and kind == "expense":
                connection.execute("UPDATE cards SET balance_cents=balance_cents+? WHERE id=?", (cents, card["id"]))
            elif card and kind == "card_payment":
                connection.execute("UPDATE cards SET balance_cents=balance_cents-? WHERE id=?", (cents, card["id"]))
        return ids[0]

    def update_transaction(self, transaction_id: int, data: dict[str, Any]) -> None:
        with self.database.transaction() as connection:
            old = connection.execute("SELECT * FROM transactions WHERE id=?", (transaction_id,)).fetchone()
            if not old:
                raise ValueError("Lançamento não encontrado")
            kind = data.get("kind", old["kind"])
            cents = int(data["amountCents"]) if data.get("amountCents") is not None else (
                to_cents(data["amount"]) if "amount" in data else old["amount_cents"]
            )
            category = self._resolve_category(connection, kind, data.get("category", old["category"]))
            card = None if kind == "income" else self._card(connection, data.get("card", old["card_id"]))
            if kind == "card_payment" and not card:
                raise ValueError("Pagamento precisa de um cartão")
            if old["card_id"] and old["kind"] == "expense":
                connection.execute("UPDATE cards SET balance_cents=MAX(0,balance_cents-?) WHERE id=?", (old["amount_cents"], old["card_id"]))
            elif old["card_id"] and old["kind"] == "card_payment":
                connection.execute("UPDATE cards SET balance_cents=balance_cents+? WHERE id=?", (old["amount_cents"], old["card_id"]))
            if kind == "card_payment" and cents > card["balance_cents"]:
                raise ValueError("O pagamento é maior do que a fatura em aberto")
            connection.execute(
                "UPDATE transactions SET occurred_on=?,amount_cents=?,kind=?,category=?,card_id=?,note=? WHERE id=?",
                (valid_date(data.get("date", old["occurred_on"])), cents, kind, category, card["id"] if card else None, str(data.get("note", old["note"])).strip(), transaction_id),
            )
            if card and kind == "expense":
                connection.execute("UPDATE cards SET balance_cents=balance_cents+? WHERE id=?", (cents, card["id"]))
            elif card and kind == "card_payment":
                connection.execute("UPDATE cards SET balance_cents=balance_cents-? WHERE id=?", (cents, card["id"]))

    def delete_transaction(self, transaction_id: int) -> None:
        with self.database.transaction() as connection:
            row = connection.execute("SELECT * FROM transactions WHERE id=?", (transaction_id,)).fetchone()
            if not row:
                raise ValueError("Lançamento não encontrado")
            if row["card_id"] and row["kind"] == "expense":
                connection.execute("UPDATE cards SET balance_cents=MAX(0,balance_cents-?) WHERE id=?", (row["amount_cents"], row["card_id"]))
            elif row["card_id"] and row["kind"] == "card_payment":
                connection.execute("UPDATE cards SET balance_cents=balance_cents+? WHERE id=?", (row["amount_cents"], row["card_id"]))
            connection.execute("DELETE FROM transactions WHERE id=?", (transaction_id,))

    def snapshot(self) -> dict[str, Any]:
        today = local_today()
        start, end = today.replace(day=1), today.replace(day=monthrange(today.year, today.month)[1])
        with self.database.connect() as connection:
            cards_raw = [dict(row) for row in connection.execute("SELECT * FROM cards ORDER BY name COLLATE NOCASE")]
            budgets_raw = [dict(row) for row in connection.execute("SELECT * FROM budgets ORDER BY category")]
            rows = [dict(row) for row in connection.execute("SELECT * FROM transactions ORDER BY occurred_on DESC,id DESC")]
        month_rows = [row for row in rows if start.isoformat() <= row["occurred_on"] <= end.isoformat()]
        spent: dict[str, int] = {}
        for row in month_rows:
            if row["kind"] == "expense":
                spent[row["category"]] = spent.get(row["category"], 0) + row["amount_cents"]
        income = sum(row["amount_cents"] for row in month_rows if row["kind"] == "income")
        expense = sum(row["amount_cents"] for row in month_rows if row["kind"] == "expense")
        cash = sum(row["amount_cents"] * (1 if row["kind"] == "income" else -1) for row in rows if row["kind"] != "expense" or not row["card_id"])
        cards = []
        for card in cards_raw:
            due = date(today.year, today.month, card["due_day"])
            if due < today:
                next_month = today.replace(day=28) + timedelta(days=4)
                due = date(next_month.year, next_month.month, card["due_day"])
            cards.append({
                "id": card["id"], "name": card["name"], "limitCents": card["limit_cents"],
                "balanceCents": card["balance_cents"], "closeDay": card["close_day"], "dueDay": card["due_day"],
                "dueOn": due.isoformat(), "daysUntilDue": (due - today).days,
                "ratio": card["balance_cents"] / card["limit_cents"] if card["limit_cents"] else 0,
            })
        budgets = [{
            "category": item["category"], "label": category_label("expense", item["category"]),
            "limitCents": item["limit_cents"], "spentCents": spent.get(item["category"], 0),
            "ratio": spent.get(item["category"], 0) / item["limit_cents"] if item["limit_cents"] else 0,
        } for item in budgets_raw]
        situation = build_situation(today, income, expense, budgets, cards, rows)
        recent = [{
            "id": row["id"], "occurredOn": row["occurred_on"], "amountCents": row["amount_cents"],
            "kind": row["kind"], "category": row["category"],
            "categoryLabel": "Pagamento" if row["kind"] == "card_payment" else category_label(row["kind"], row["category"]),
            "cardId": row["card_id"], "cardName": next((c["name"] for c in cards if c["id"] == row["card_id"]), None),
            "note": row["note"], "source": row["source"] or "painel",
        } for row in rows[:40]]
        alerts = self._sync_alerts(self._alerts(today, budgets, cards), today)
        xp = sum(18 if row["kind"] == "income" else 30 if row["kind"] == "card_payment" else 12 for row in rows)
        levels = [(1, 0, "Aprendiz do caixa"), (2, 120, "Organizador"), (3, 300, "Guardião"), (4, 600, "Estrategista"), (5, 1000, "Mestre do Cofre")]
        current = max((entry for entry in levels if xp >= entry[1]), key=lambda entry: entry[0])
        following = next((entry for entry in levels if entry[1] > xp), None)
        game = {
            "level": current[0], "title": current[2], "xp": xp,
            "nextXp": following[1] if following else None, "nextTitle": following[2] if following else None,
            "remaining": following[1] - xp if following else 0,
            "progress": (xp - current[1]) / (following[1] - current[1]) if following else 1,
            "streak": 0, "badges": [
                {"id": "primeiro", "name": "Primeiro lançamento", "earned": bool(rows), "hint": "Registre qualquer movimento."},
                {"id": "pagador", "name": "Pagador", "earned": any(r["kind"] == "card_payment" for r in rows), "hint": "Registre um pagamento de cartão."},
            ],
        }
        challenge = {"id": "registrar", "title": "Registrar o dia", "detail": "Lance pelo menos um movimento hoje.", "meterKind": "progress", "done": any(r["logged_on"] == today.isoformat() for r in rows), "meter": 1 if any(r["logged_on"] == today.isoformat() for r in rows) else 0, "status": "Feito hoje" if any(r["logged_on"] == today.isoformat() for r in rows) else "Ainda falta um lançamento"}
        agents = [
            {"id": "nara", "name": "Nara", "role": "Tesoureira", "focus": "Gastos, receitas e tetos", "line": f"Entrou {brl(income)} e saiu {brl(expense)}.", "tone": "warn" if expense > income and income else "ok"},
            {"id": "vigia", "name": "Vigia", "role": "Crédito", "focus": "Limite, fatura e vencimento", "line": "Crédito acompanhado." if cards else "Sem cartão cadastrado.", "tone": "ok"},
            {"id": "luma", "name": "Luma", "role": "Coach", "focus": "XP, selos e desafios", "line": f'Situação {situation["headline"].lower()}. Nível {current[0]}, {current[2]}.', "tone": "ok"},
        ]
        custom = [(item["category"], item["label"]) for item in budgets if item["category"] not in dict(EXPENSE_CATEGORIES)]
        return {
            "today": today.isoformat(), "month": today.strftime("%Y-%m"), "demo": self.setting("demo") == "1",
            "cashCents": cash, "monthIncomeCents": income, "monthExpenseCents": expense,
            "monthResultCents": income - expense, "todayExpenseCents": sum(r["amount_cents"] for r in month_rows if r["kind"] == "expense" and r["occurred_on"] == today.isoformat()),
            "cards": cards, "budgets": budgets, "transactions": recent, "alerts": alerts,
            "game": game, "situation": situation, "challenge": challenge, "agents": agents,
            "categories": {
                "expense": [{"id": key, "label": label} for key, label in EXPENSE_CATEGORIES + custom],
                "income": [{"id": key, "label": label} for key, label in INCOME_CATEGORIES],
            },
        }

    def _sync_alerts(self, alerts: list[dict[str, Any]], today: date) -> list[dict[str, Any]]:
        active = {item["fingerprint"] for item in alerts}
        with self.database.transaction() as connection:
            for item in alerts:
                connection.execute(
                    """
                    INSERT INTO alert_log(fingerprint,level,agent,title,body,active,sent_at,sent_on)
                    VALUES(?,?,?,?,?,1,NULL,NULL)
                    ON CONFLICT(fingerprint) DO UPDATE SET
                      level=excluded.level, agent=excluded.agent, title=excluded.title,
                      body=excluded.body, active=1,
                      sent_at=CASE WHEN alert_log.active=0 THEN NULL ELSE alert_log.sent_at END,
                      sent_on=CASE WHEN alert_log.active=0 THEN NULL ELSE alert_log.sent_on END
                    """,
                    (item["fingerprint"], item["level"], item["agent"], item["title"], item["body"]),
                )
            rows = connection.execute("SELECT fingerprint FROM alert_log WHERE active=1").fetchall()
            for row in rows:
                if row["fingerprint"] not in active:
                    connection.execute("UPDATE alert_log SET active=0 WHERE fingerprint=?", (row["fingerprint"],))
            stored = {
                row["fingerprint"]: row
                for row in connection.execute("SELECT * FROM alert_log WHERE active=1").fetchall()
            }
        result = []
        for item in alerts:
            row = stored.get(item["fingerprint"])
            pending = bool(row) and (
                not row["sent_on"] or (item["level"] == "critico" and row["sent_on"] < today.isoformat())
            )
            result.append({**item, "pending": pending})
        return result

    def mark_alerts_sent(self, fingerprints: list[str]) -> None:
        now = datetime.now(timezone.utc).isoformat()
        today = local_today().isoformat()
        with self.database.connect() as connection:
            connection.executemany(
                "UPDATE alert_log SET sent_at=?,sent_on=? WHERE fingerprint=?",
                [(now, today, fingerprint) for fingerprint in fingerprints],
            )

    @staticmethod
    def _alerts(today: date, budgets: list[dict[str, Any]], cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
        alerts = []
        for item in budgets:
            if item["ratio"] >= .8:
                over = item["ratio"] >= 1
                alerts.append({"fingerprint": f'budget:{item["category"]}:{today:%Y-%m}:{"over" if over else "warn"}', "level": "critico" if over else "atencao", "agent": "Nara", "title": f'{item["label"]} {"estourou o teto" if over else "chegou a " + str(round(item["ratio"] * 100)) + "%"}', "body": f'{brl(item["spentCents"])} de {brl(item["limitCents"])} neste mês.', "pending": False})
        for item in cards:
            if item["ratio"] >= .3:
                alerts.append({"fingerprint": f'credit:{item["id"]}', "level": "critico" if item["ratio"] >= .7 else "atencao", "agent": "Vigia", "title": f'{item["name"]} está em {round(item["ratio"] * 100)}% do limite', "body": f'Fatura em {brl(item["balanceCents"])} de {brl(item["limitCents"])}.', "pending": False})
        return alerts

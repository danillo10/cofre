from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

TEMP = tempfile.TemporaryDirectory()
os.environ["COFRE_DB"] = str(Path(TEMP.name) / "cofre.sqlite")
os.environ.pop("TELEGRAM_BOT_TOKEN", None)

from fastapi.testclient import TestClient

from cofre_app.db import Database
from cofre_app.ai import FinancialIntent, TransactionDraft
from cofre_app.engine import Cofre, to_cents
from cofre_app.main import app
from cofre_app.telegram import apply_intent


class EngineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.cofre = Cofre(Database(Path(self.temp.name) / "test.sqlite"))

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_crud_custom_categories_installments_and_history(self) -> None:
        self.assertEqual(to_cents("1.234,56"), 123456)
        self.cofre.set_budget("Energia Solar", "350")
        card_id = self.cofre.add_card({"name": "Nubank", "limit": 1000, "closeDay": 3, "dueDay": 10})
        description = "descrição detalhada " * 400
        first_id = self.cofre.add_transaction({
            "kind": "expense", "amount": 100, "category": "energia_solar",
            "card": card_id, "note": description, "installmentCount": 3,
        })
        state = self.cofre.snapshot()
        parts = [row for row in state["transactions"] if "parcela" in row["note"]]
        self.assertEqual(sum(row["amountCents"] for row in parts), 10000)
        self.assertEqual(len(parts), 3)
        self.assertGreater(len(parts[0]["note"]), 160)
        self.assertIn("energia_solar", [item["id"] for item in state["categories"]["expense"]])
        self.cofre.update_transaction(first_id, {"amount": 40, "note": "corrigida"})
        self.assertEqual(self.cofre.snapshot()["transactions"][-1]["note"], "corrigida")
        self.cofre.add_message("123", "user", "qual foi meu gasto?")
        self.cofre.add_message("123", "assistant", "Foi registrado.")
        self.assertEqual([item["role"] for item in self.cofre.history("123")], ["user", "assistant"])

    def test_card_delete_guard_and_crud(self) -> None:
        card_id = self.cofre.add_card({"name": "Inter", "limit": 2000, "closeDay": 5, "dueDay": 12})
        self.cofre.update_card(card_id, {"name": "Inter Gold", "limit": 2500})
        self.assertEqual(self.cofre.snapshot()["cards"][0]["name"], "Inter Gold")
        self.cofre.delete_card(card_id)
        self.assertEqual(self.cofre.snapshot()["cards"], [])

    def test_langchain_intent_keeps_separate_accounts_and_descriptions(self) -> None:
        self.cofre.set_budget("mercado", 100)
        intent = FinancialIntent(
            intent="transaction",
            transactions=[
                TransactionDraft(
                    kind="expense", amount_cents=9000, category="mercado",
                    note="Compra de alimentos no Mercado Central",
                ),
                TransactionDraft(
                    kind="expense", amount_cents=3500, category="outros",
                    note="Produto de limpeza na Loja da Esquina",
                ),
            ],
        )
        reply = apply_intent(self.cofre, intent, "registre estas duas contas")
        state = self.cofre.snapshot()
        self.assertEqual(len(state["transactions"]), 2)
        self.assertEqual(
            {row["note"] for row in state["transactions"]},
            {"Compra de alimentos no Mercado Central", "Produto de limpeza na Loja da Esquina"},
        )
        self.assertIn("Nara registrou:", reply)
        self.assertTrue(any(alert["pending"] for alert in state["alerts"]))


class ApiTest(unittest.TestCase):
    def test_public_contract_and_static_files(self) -> None:
        with TestClient(app) as client:
            response = client.get("/api/state")
            self.assertEqual(response.status_code, 200)
            data = response.json()
            for key in ("cards", "budgets", "transactions", "categories", "situation", "game", "agents", "telegram"):
                self.assertIn(key, data)
            created = client.post("/api/budgets", json={"category": "pet", "limit": "250"})
            self.assertEqual(created.status_code, 200)
            self.assertTrue(any(item["category"] == "pet" for item in created.json()["budgets"]))
            self.assertEqual(client.get("/").status_code, 200)


if __name__ == "__main__":
    unittest.main()

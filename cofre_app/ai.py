from __future__ import annotations

import base64
import os
from typing import Any, Literal

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field


class TransactionDraft(BaseModel):
    kind: Literal["expense", "income", "card_payment"]
    amount_cents: int = Field(gt=0, le=100_000_000)
    category: str | None = None
    category_name: str | None = None
    card: str | None = None
    date: str | None = None
    note: str
    installment_count: int = Field(default=1, ge=1, le=60)


class FinancialIntent(BaseModel):
    intent: Literal[
        "transaction", "edit_transaction", "delete_transaction",
        "budget", "delete_budget", "summary", "help", "chat", "unknown",
    ]
    transaction_id: int | None = None
    kind: Literal["expense", "income", "card_payment"] | None = None
    amount_cents: int | None = None
    category: str | None = None
    category_name: str | None = None
    card: str | None = None
    date: str | None = None
    note: str | None = None
    installment_count: int = Field(default=1, ge=1, le=60)
    transactions: list[TransactionDraft] = Field(default_factory=list)
    reply: str | None = None


def enabled() -> bool:
    return bool(os.environ.get("OPENAI_API_KEY", "").strip())


def understand(
    text: str,
    state: dict[str, Any],
    history: list[dict[str, str]] | None = None,
    image: tuple[bytes, str] | None = None,
    ocr_text: str = "",
) -> FinancialIntent | None:
    if not enabled():
        return None
    model = ChatOpenAI(
        model=os.environ.get("OPENAI_MODEL", "gpt-4o"),
        temperature=0,
        timeout=30,
    ).with_structured_output(FinancialIntent, method="json_schema")
    context = {
        "today": state["today"],
        "cards": [{"name": c["name"], "balanceCents": c["balanceCents"]} for c in state["cards"]],
        "budgets": [{"category": b["category"], "limitCents": b["limitCents"]} for b in state["budgets"]],
        "categories": state.get("categories", {}),
        "recentTransactions": state["transactions"][:20],
        "history": (history or [])[-20:],
    }
    instructions = """
Você é Nara, assistente financeira pessoal brasileira. Extraia uma ação estruturada.
transaction registra um ou mais gastos, receitas ou pagamentos já realizados. Para essa intenção,
preencha transactions com UMA entrada por conta, compra ou linha distinta. Em foto de lista,
fatura ou extrato, não agrupe valores diferentes e não transforme a quantidade de linhas em
parcelas. Percorra o texto e a imagem inteiros: toda linha visível que tenha descrição e valor
deve aparecer em transactions; nunca devolva apenas a primeira conta de uma lista. Ignore linhas
negativas somente quando o usuário pedir. Compra no cartão é expense;
card_payment é somente pagamento de fatura. amount_cents é inteiro em centavos.
Use category com o id de uma categoria disponível quando ela combinar com a conta. Se nenhuma
categoria disponível servir, preencha category_name com um nome específico para ela ser criada;
não deixe ambos vazios quando a finalidade da conta estiver clara.
edit_transaction e delete_transaction exigem um transaction_id existente no contexto.
budget cria ou altera teto; delete_budget exclui teto. Preserve categorias personalizadas em
category_name. Em foto leia TOTAL, data, estabelecimento e parcelas; não some itens quando
o documento for um único cupom. installment_count é maior que 1 somente se a própria conta
indicar parcelamento (como 4x ou parcela 1/4). Não invente valor, cartão ou id.
Em compra parcelada, amount_cents é o valor TOTAL da compra. Se o documento informar somente
o valor de cada parcela e a quantidade, calcule o total multiplicando os dois.
Cada transação deve ter note específico e completo com produto, loja ou finalidade; nunca copie
uma instrução genérica como "lance esses gastos" para note. Para ação incompleta use unknown e faça uma
pergunta curta em reply. Responda em português.
"""
    prompt = f"Contexto: {context}\nOCR: {ocr_text}\nPedido atual: {text or 'Analise a imagem.'}"
    if image:
        data, mime = image
        content: list[dict[str, Any]] = [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(data).decode()}"}},
        ]
        message = HumanMessage(content=content)
    else:
        message = HumanMessage(content=prompt)
    return model.invoke([SystemMessage(content=instructions), message])

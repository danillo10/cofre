from __future__ import annotations

import asyncio
import io
import logging
import os
from contextlib import suppress
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import pytesseract
from PIL import Image

from .ai import FinancialIntent, TransactionDraft, understand
from .engine import Cofre, normalize_category
from .situation import brl, format_situation

HELP = """Manda um gasto em texto ou uma foto do cupom.
Exemplos:
42,90 almoço
recebi 5200 de salário
defina um teto de 600 para alimentação
edite a conta #12 para 80 reais
exclua a conta #12
/resumo · /contas"""
_last_watch: dict[str, Any] = {"at": None, "sent": 0, "error": None}
logger = logging.getLogger(__name__)


def token() -> str:
    return os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()


def inbox_enabled() -> bool:
    return os.environ.get("COFRE_INBOX", "1").strip() != "0"


def status(cofre: Cofre) -> dict[str, Any]:
    active = bool(token()) and inbox_enabled()
    return {
        "listening": active,
        "chatReady": bool(os.environ.get("TELEGRAM_CHAT_ID") or cofre.setting("telegram_chat")),
        "lastWatch": _last_watch,
    }


async def _api(method: str, payload: dict[str, Any] | None = None) -> Any:
    async with httpx.AsyncClient(timeout=35) as client:
        response = await client.post(f"https://api.telegram.org/bot{token()}/{method}", json=payload or {})
        body = response.json()
        if not response.is_success or not body.get("ok"):
            raise RuntimeError(body.get("description", "Falha no Telegram"))
        return body.get("result")


async def send(cofre: Cofre, chat_id: str, text: str) -> None:
    await _api("sendMessage", {"chat_id": chat_id, "text": text, "disable_web_page_preview": True})
    cofre.add_message(chat_id, "assistant", text)


async def deliver_alerts(cofre: Cofre) -> int:
    global _last_watch
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip() or cofre.setting("telegram_chat")
    now = datetime.now(ZoneInfo("America/Sao_Paulo"))
    if not token() or not chat_id or not 8 <= now.hour < 22:
        _last_watch = {"at": now.isoformat(), "sent": 0, "error": None, "reason": "quiet"}
        return 0
    pending = [item for item in cofre.snapshot()["alerts"] if item.get("pending")]
    if not pending:
        _last_watch = {"at": now.isoformat(), "sent": 0, "error": None, "reason": "quiet"}
        return 0
    lines = ["Cofre"]
    for alert in pending:
        lines.extend(["", f'{alert["agent"]} · {alert["title"]}', alert["body"]])
    await send(cofre, str(chat_id), "\n".join(lines))
    cofre.mark_alerts_sent([item["fingerprint"] for item in pending])
    _last_watch = {"at": now.isoformat(), "sent": len(pending), "error": None}
    return len(pending)


async def alert_loop(cofre: Cofre) -> None:
    if not inbox_enabled():
        return
    while True:
        try:
            await deliver_alerts(cofre)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            global _last_watch
            _last_watch = {"at": datetime.now().isoformat(), "sent": 0, "error": str(error)}
        await asyncio.sleep(30 * 60)


def _allowed(cofre: Cofre, chat_id: str) -> bool:
    configured = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    known = configured or cofre.setting("telegram_chat")
    if known:
        return known == chat_id
    cofre.put_setting("telegram_chat", chat_id)
    return True


async def _photo(file_id: str) -> tuple[bytes, str]:
    metadata = await _api("getFile", {"file_id": file_id})
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(f'https://api.telegram.org/file/bot{token()}/{metadata["file_path"]}')
        response.raise_for_status()
    if len(response.content) > 15 * 1024 * 1024:
        raise ValueError("A imagem passou de 15 MB")
    received = response.headers.get("content-type", "")
    suffix = str(metadata.get("file_path", "")).lower().rsplit(".", 1)[-1]
    inferred = {
        "png": "image/png", "webp": "image/webp", "gif": "image/gif",
        "jpg": "image/jpeg", "jpeg": "image/jpeg",
    }.get(suffix, "image/jpeg")
    return response.content, received if received.startswith("image/") else inferred


async def _ocr(data: bytes) -> str:
    def read() -> str:
        image = Image.open(io.BytesIO(data))
        for language in ("por+eng", "por", "eng"):
            with suppress(Exception):
                value = pytesseract.image_to_string(image, lang=language)
                if value.strip():
                    return value
        return pytesseract.image_to_string(image)
    return await asyncio.to_thread(read)


def apply_intent(cofre: Cofre, intent: FinancialIntent, raw_text: str) -> str:
    state = cofre.snapshot()
    if intent.intent == "transaction":
        drafts = list(intent.transactions)
        if not drafts and intent.kind and intent.amount_cents:
            drafts = [TransactionDraft(
                kind=intent.kind,
                amount_cents=intent.amount_cents,
                category=intent.category,
                category_name=intent.category_name,
                card=intent.card,
                date=intent.date,
                note=intent.note or raw_text,
                installment_count=intent.installment_count,
            )]
        if not drafts:
            raise ValueError("Não encontrei nenhuma conta completa para registrar.")
        items = [{
            "kind": draft.kind,
            "amountCents": draft.amount_cents,
            "category": draft.category_name or draft.category or "outros",
            "card": draft.card,
            "date": draft.date or state["today"],
            "note": draft.note,
            "installmentCount": draft.installment_count,
            "source": "telegram",
            "rawText": raw_text,
        } for draft in drafts]
        id_groups = cofre.add_transactions(items)
        confirmations: list[str] = []
        for draft, ids in zip(drafts, id_groups, strict=True):
            first_id, last_id = ids[0], ids[-1]
            reference = f"#{first_id}" if last_id == first_id else f"#{first_id}–#{last_id}"
            preview = draft.note if len(draft.note) <= 180 else f"{draft.note[:179]}…"
            parcels = f" em {draft.installment_count} parcelas" if draft.installment_count > 1 else ""
            confirmations.append(f"{reference} · {preview} · {brl(draft.amount_cents)}{parcels}")
        shown = confirmations[:12]
        if len(confirmations) > len(shown):
            shown.append(f"… e mais {len(confirmations) - len(shown)} conta(s).")
        return "\n".join(["Nara registrou:", *shown, "", format_situation(cofre.snapshot()["situation"])])
    if intent.intent == "edit_transactions":
        if not intent.selector or not intent.changes:
            raise ValueError("Diga quais contas devem mudar e quais são os novos dados.")
        selector = intent.selector.model_dump(exclude_none=True)
        ids = cofre.find_transaction_ids(selector)
        if not ids:
            raise ValueError("Não encontrei contas que correspondam à data, descrição ou valor informado.")
        raw_changes = intent.changes.model_dump(exclude_none=True)
        changes = {
            key: value for key, value in {
                "kind": raw_changes.get("kind"),
                "amountCents": raw_changes.get("amount_cents"),
                "category": raw_changes.get("category_name") or raw_changes.get("category"),
                "card": raw_changes.get("card"),
                "date": raw_changes.get("date"),
                "note": raw_changes.get("note"),
            }.items() if value is not None
        }
        cofre.update_transactions(ids, changes)
        shown_ids = ", ".join(f"#{value}" for value in ids[:15])
        suffix = f" e mais {len(ids) - 15}" if len(ids) > 15 else ""
        return f"{len(ids)} contas atualizadas: {shown_ids}{suffix}."
    if intent.intent == "edit_transaction":
        if intent.transaction_id is None:
            raise ValueError("Diga o número da conta que devo editar.")
        changes = {
            key: value for key, value in {
                "kind": intent.kind, "amountCents": intent.amount_cents,
                "category": intent.category_name or intent.category, "card": intent.card,
                "date": intent.date, "note": intent.note,
            }.items() if value is not None
        }
        cofre.update_transaction(intent.transaction_id, changes)
        return f"Conta #{intent.transaction_id} atualizada."
    if intent.intent == "delete_transaction":
        if intent.transaction_id is None:
            raise ValueError("Diga o número da conta que devo excluir.")
        cofre.delete_transaction(intent.transaction_id)
        return f"Conta #{intent.transaction_id} excluída."
    if intent.intent == "budget":
        category = normalize_category(intent.category_name or intent.category or "")
        if intent.amount_cents is None:
            raise ValueError("Diga o valor do teto.")
        cofre.set_budget(category, intent.amount_cents / 100)
        return f"Teto de {category.replace('_', ' ').title()} atualizado para {brl(intent.amount_cents)}."
    if intent.intent == "delete_budget":
        category = normalize_category(intent.category_name or intent.category or "")
        cofre.delete_budget(category)
        return f"Teto de {category.replace('_', ' ').title()} excluído."
    if intent.intent == "summary":
        return intent.reply or format_situation(state["situation"])
    return intent.reply or HELP


async def handle_message(cofre: Cofre, message: dict[str, Any]) -> None:
    chat_id = str(message["chat"]["id"])
    if not _allowed(cofre, chat_id):
        await send(cofre, chat_id, "Este Cofre já está ligado a outra conversa.")
        return
    text = (message.get("text") or message.get("caption") or "").strip()
    folded = text.lower().lstrip("/")
    if folded == "start":
        await send(cofre, chat_id, HELP)
        return
    if folded == "resumo":
        await send(cofre, chat_id, format_situation(cofre.snapshot()["situation"]))
        return
    if folded == "contas":
        rows = cofre.snapshot()["transactions"][:10]
        answer = "Ainda não há contas." if not rows else "\n".join(
            ["Últimas contas"] + [
                f'#{r["id"]} · {r["occurredOn"]} · {r["note"] or r["categoryLabel"]} · {brl(r["amountCents"])}'
                for r in rows
            ]
        )
        await send(cofre, chat_id, answer)
        return
    image = None
    ocr = ""
    if message.get("photo"):
        image = await _photo(message["photo"][-1]["file_id"])
        ocr = await _ocr(image[0])
    if not text and not image:
        await send(cofre, chat_id, HELP)
        return
    history = cofre.history(chat_id)
    cofre.add_message(chat_id, "user", text or f"[Imagem]\n{ocr}")
    intent = await asyncio.to_thread(understand, text, cofre.snapshot(), history, image, ocr)
    if not intent:
        await send(cofre, chat_id, "A IA não está configurada. Defina OPENAI_API_KEY.")
        return
    await send(cofre, chat_id, apply_intent(cofre, intent, text or ocr))
    await deliver_alerts(cofre)


async def polling_loop(cofre: Cofre) -> None:
    if not token() or not inbox_enabled():
        return
    offset = int(cofre.setting("telegram_offset", "0") or 0)
    while True:
        try:
            updates = await _api("getUpdates", {"offset": offset, "timeout": 25, "allowed_updates": ["message"]})
            for update in updates:
                offset = update["update_id"] + 1
                if not cofre.claim_update(update["update_id"]):
                    continue
                message = update.get("message")
                if message and message.get("chat", {}).get("type") == "private":
                    try:
                        await handle_message(cofre, message)
                    except Exception:
                        logger.exception("Falha ao processar mensagem do Telegram")
                        with suppress(Exception):
                            await send(
                                cofre,
                                str(message["chat"]["id"]),
                                "Não consegui concluir essa mensagem. Tente novamente com valor, descrição e parcelas.",
                            )
            cofre.put_setting("telegram_offset", offset)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Falha no polling do Telegram")
            await asyncio.sleep(4)

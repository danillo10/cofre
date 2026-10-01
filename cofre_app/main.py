from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict

from .ai import understand
from .db import ROOT, Database
from .engine import Cofre
from .telegram import alert_loop, apply_intent, polling_loop, status

load_dotenv(ROOT / ".env")


class Payload(BaseModel):
    model_config = ConfigDict(extra="allow")


database = Database()
cofre = Cofre(database)


def state() -> dict[str, Any]:
    value = cofre.snapshot()
    telegram = status(cofre)
    value["telegram"] = {**telegram, "configured": telegram["chatReady"]}
    return value


def run(action: Any) -> dict[str, Any]:
    try:
        action()
        return state()
    except (ValueError, TypeError, KeyError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@asynccontextmanager
async def lifespan(_: FastAPI):
    tasks = [
        asyncio.create_task(polling_loop(cofre)),
        asyncio.create_task(alert_loop(cofre)),
    ]
    yield
    for task in tasks:
        task.cancel()
    for task in tasks:
        with suppress(asyncio.CancelledError):
            await task


app = FastAPI(title="Cofre", version="2.0.0", lifespan=lifespan)


@app.exception_handler(HTTPException)
async def http_error(_: Request, error: HTTPException) -> JSONResponse:
    return JSONResponse({"error": str(error.detail), "code": None}, status_code=error.status_code)


@app.get("/api/state")
def get_state() -> dict[str, Any]:
    return state()


@app.post("/api/launch")
async def launch(payload: Payload) -> dict[str, Any]:
    data = payload.model_dump(exclude_none=True)
    text = str(data.get("text", "")).strip()
    if not text:
        raise HTTPException(status_code=400, detail="Texto vazio")
    intent = await asyncio.to_thread(understand, text, cofre.snapshot())
    if not intent:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY não configurada")
    try:
        apply_intent(cofre, intent, text)
        return state()
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/api/transactions")
def add_transaction(payload: Payload) -> dict[str, Any]:
    data = payload.model_dump(exclude_none=True)
    return run(lambda: cofre.add_transaction(data))


@app.patch("/api/transactions/{transaction_id}")
def update_transaction(transaction_id: int, payload: Payload) -> dict[str, Any]:
    data = payload.model_dump(exclude_none=True)
    return run(lambda: cofre.update_transaction(transaction_id, data))


@app.delete("/api/transactions/{transaction_id}")
def delete_transaction(transaction_id: int) -> dict[str, Any]:
    return run(lambda: cofre.delete_transaction(transaction_id))


@app.post("/api/cards")
def add_card(payload: Payload) -> dict[str, Any]:
    data = payload.model_dump(exclude_none=True)
    return run(lambda: cofre.add_card(data))


@app.patch("/api/cards/{card_id}")
def update_card(card_id: int, payload: Payload) -> dict[str, Any]:
    data = payload.model_dump(exclude_none=True)
    return run(lambda: cofre.update_card(card_id, data))


@app.delete("/api/cards/{card_id}")
def delete_card(card_id: int) -> dict[str, Any]:
    return run(lambda: cofre.delete_card(card_id))


@app.post("/api/budgets")
def set_budget(payload: Payload) -> dict[str, Any]:
    data = payload.model_dump(exclude_none=True)
    return run(lambda: cofre.set_budget(data["category"], data["limit"]))


@app.delete("/api/budgets/{category}")
def delete_budget(category: str) -> dict[str, Any]:
    return run(lambda: cofre.delete_budget(category))


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


public = Path(ROOT / "public")
app.mount("/", StaticFiles(directory=public, html=True), name="public")

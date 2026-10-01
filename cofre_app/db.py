from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

ROOT = Path(__file__).resolve().parent.parent


def db_path() -> Path:
    return Path(os.environ.get("COFRE_DB", ROOT / "data" / "cofre.sqlite")).expanduser()


class Database:
    """SQLite connection factory and backwards-compatible schema migration."""

    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path) if path else db_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.migrate()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        return connection

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self.connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def migrate(self) -> None:
        with self.connect() as connection:
            connection.executescript(
                """
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS settings (
                  key TEXT PRIMARY KEY, value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS cards (
                  id INTEGER PRIMARY KEY,
                  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                  limit_cents INTEGER NOT NULL,
                  close_day INTEGER NOT NULL,
                  due_day INTEGER NOT NULL,
                  balance_cents INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS budgets (
                  category TEXT PRIMARY KEY, limit_cents INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS custom_categories (
                  key TEXT PRIMARY KEY, label TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS transactions (
                  id INTEGER PRIMARY KEY,
                  occurred_on TEXT NOT NULL,
                  logged_on TEXT NOT NULL,
                  amount_cents INTEGER NOT NULL,
                  kind TEXT NOT NULL,
                  category TEXT NOT NULL,
                  card_id INTEGER,
                  note TEXT NOT NULL DEFAULT '',
                  created_at TEXT NOT NULL,
                  source TEXT NOT NULL DEFAULT 'painel',
                  raw_text TEXT NOT NULL DEFAULT '',
                  FOREIGN KEY (card_id) REFERENCES cards(id)
                );
                CREATE TABLE IF NOT EXISTS telegram_updates (
                  update_id INTEGER PRIMARY KEY
                );
                CREATE TABLE IF NOT EXISTS conversation_messages (
                  id INTEGER PRIMARY KEY,
                  chat_id TEXT NOT NULL,
                  role TEXT NOT NULL,
                  content TEXT NOT NULL,
                  created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS conversation_messages_chat
                  ON conversation_messages(chat_id, id);
                CREATE TABLE IF NOT EXISTS alert_log (
                  fingerprint TEXT PRIMARY KEY,
                  level TEXT NOT NULL,
                  agent TEXT NOT NULL,
                  title TEXT NOT NULL,
                  body TEXT NOT NULL,
                  active INTEGER NOT NULL DEFAULT 1,
                  sent_at TEXT,
                  sent_on TEXT
                );
                """
            )
            columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(transactions)").fetchall()
            }
            if "source" not in columns:
                connection.execute(
                    "ALTER TABLE transactions ADD COLUMN source TEXT NOT NULL DEFAULT 'painel'"
                )
            if "raw_text" not in columns:
                connection.execute(
                    "ALTER TABLE transactions ADD COLUMN raw_text TEXT NOT NULL DEFAULT ''"
                )

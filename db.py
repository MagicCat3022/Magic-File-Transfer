# db.py
import sqlite3
import threading
from pathlib import Path

from config import DB_PATH

_db_lock = threading.Lock()

def db_connect():
    """Return a sqlite3 connection (row factory set)."""
    con = sqlite3.connect(str(DB_PATH))
    con.row_factory = sqlite3.Row
    return con

def db_init():
    """Create tables and optional columns (idempotent / best-effort)."""
    with db_connect() as con:
        cur = con.cursor()
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS uploads (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                size INTEGER NOT NULL,
                chunk_size INTEGER NOT NULL,
                total_chunks INTEGER NOT NULL,
                checksum TEXT NOT NULL,
                finalized INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS chunks (
                upload_id TEXT NOT NULL,
                idx INTEGER NOT NULL,
                received_at TEXT NOT NULL,
                PRIMARY KEY (upload_id, idx),
                FOREIGN KEY (upload_id) REFERENCES uploads(id)
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS upload_stats (
                upload_id TEXT PRIMARY KEY,
                bytes_received INTEGER NOT NULL DEFAULT 0,
                first_chunk_at TEXT,
                last_activity_end TEXT,
                downtime_seconds REAL NOT NULL DEFAULT 0,
                upload_active_seconds REAL NOT NULL DEFAULT 0,
                assembly_seconds REAL NOT NULL DEFAULT 0,
                finalized_at TEXT,
                FOREIGN KEY (upload_id) REFERENCES uploads(id)
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS chunk_events (
                upload_id TEXT NOT NULL,
                idx INTEGER NOT NULL,
                start_ts TEXT,
                end_ts TEXT,
                bytes INTEGER,
                duration REAL,
                PRIMARY KEY (upload_id, idx),
                FOREIGN KEY (upload_id) REFERENCES uploads(id)
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                user_id TEXT PRIMARY KEY,
                last_upload_id TEXT,
                logs TEXT DEFAULT ''
            )
            """
        )
        con.commit()

        # Add optional columns (best-effort, ignore errors)
        extras = [
            ("upload_start", "TEXT"),
            ("upload_end", "TEXT"),
            ("current_concurrency", "INTEGER DEFAULT 0"),
            ("concurrency_change_at", "TEXT"),
            ("concurrency_cumulative_seconds", "REAL DEFAULT 0"),
            ("peak_concurrency", "INTEGER DEFAULT 0"),
            ("user_id", "TEXT"),
        ]
        for col, definition in extras:
            try:
                cur.execute(f"ALTER TABLE upload_stats ADD COLUMN {col} {definition}")
            except Exception:
                pass

        try:
            cur.execute("ALTER TABLE uploads ADD COLUMN user_id TEXT")
        except Exception:
            pass

        con.commit()

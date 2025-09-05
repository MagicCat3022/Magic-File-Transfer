"""
Resumable LAN File Drop (single-file Flask app)

Features
- Web UI for uploading files over local network
- Chunked uploads with resume support (order-agnostic)
- TCP-based reliability via HTTP; application-level chunk indexing and checksum validation
- Works even if connection drops; resumes by file name + checksum
- Concurrent chunk uploads from the browser

Run
  pip install flask werkzeug
  python app.py
Then visit http://<server-ip>:5000 from any device on the same LAN.

Settings
- UPLOAD_DIR: final assembled files
- STAGING_DIR: per-upload temporary chunk storage
- MAX_FILE_SIZE: safety limit (bytes)
- CHUNK_SIZE_MAX: max accepted chunk size (bytes)

Security notes
- Filenames are sanitized to prevent path traversal
- Simple token-less design for trusted LANs. Add auth/restrictions for wider use.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import string
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

from flask import (
    Flask,
    Response,
    jsonify,
    make_response,
    redirect,
    render_template_string,
    request,
    send_from_directory,
)
from werkzeug.utils import secure_filename

APP_TITLE = "LAN File Drop"
UPLOAD_DIR = Path("uploads")
STAGING_DIR = Path("staging")
DB_PATH = Path("db/filedrop.db")
MAX_FILE_SIZE = 50 * 1024 * 1024 * 1024  # 50 GiB
CHUNK_SIZE_MAX = 64 * 1024 * 1024  # 64 MiB per chunk (tune as needed)
DOWNTIME_THRESHOLD = 2.0  # seconds: gaps longer than this count as downtime

UPLOAD_DIR.mkdir(exist_ok=True)
STAGING_DIR.mkdir(exist_ok=True)

app = Flask(__name__)
app.config.update(MAX_CONTENT_LENGTH=CHUNK_SIZE_MAX + 1024 * 1024)  # allow some header overhead
_db_lock = threading.Lock()


def db_connect():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def db_init():
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
        # New per-upload persistent stats table
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
        # Detailed per-chunk timings (start/end/bytes/duration) for more verbose stats
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
        # Session storage for per-browser logs and last-upload mapping (keyed by cookie)
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

        # Add new columns to upload_stats if they don't exist (idempotent / best-effort)
        # sqlite won't error on ADD COLUMN attempts when wrapped in try/except
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
        # also add user_id column to uploads table if missing so we can associate uploads -> user
        try:
            cur.execute("ALTER TABLE uploads ADD COLUMN user_id TEXT")
        except Exception:
            pass
        con.commit()


def sanitize_filename(name: str) -> str:
    # werkzeug.secure_filename plus an extra safety net
    base = secure_filename(name)
    # limit length
    return base[:255] if base else f"upload-{uuid.uuid4().hex}"


def now_iso() -> str:
    # use millisecond precision to avoid second-granularity rounding artifacts
    return datetime.utcnow().isoformat(timespec="milliseconds") + "Z"


@app.get("/")
def index():
    # Create or preserve a browser cookie that identifies this client
    user_cookie = request.cookies.get("mf_user")
    if not user_cookie:
        user_cookie = uuid.uuid4().hex
    resp = make_response(render_template_string(INDEX_HTML, app_title=APP_TITLE, chunk_size_max=CHUNK_SIZE_MAX))
    # persistent cookie, HttpOnly
    resp.set_cookie("mf_user", user_cookie, max_age=30 * 24 * 3600, httponly=True)
    return resp


@app.post("/initiate")
def initiate():
    data = request.get_json(force=True)
    filename = sanitize_filename(data.get("filename", ""))
    size = int(data.get("size", 0))
    chunk_size = int(data.get("chunk_size", 0))
    checksum = (data.get("checksum") or "").lower()

    # filename, size and chunk_size are required; checksum is optional (fallback used when missing)
    if not filename or size <= 0 or chunk_size <= 0:
        return jsonify(error="invalid-params"), 400
    if not checksum:
        # WebCrypto may be unavailable on non-HTTPS LAN URLs (e.g. http://192.168.x.y).
        # Use a deterministic fallback key so resume still works when browser couldn't compute SHA-256.
        checksum = f"NOCHK:{filename}:{size}"

    if size > MAX_FILE_SIZE:
        return jsonify(error="file-too-large", max_bytes=MAX_FILE_SIZE), 413
    if chunk_size > CHUNK_SIZE_MAX:
        return jsonify(error="chunk-too-large", max_bytes=CHUNK_SIZE_MAX), 413

    total_chunks = (size + chunk_size - 1) // chunk_size

    # Try to find an existing (non-finalized) upload by checksum+filename+size
    with _db_lock, db_connect() as con:
        cur = con.cursor()
        cur.execute(
            "SELECT * FROM uploads WHERE checksum=? AND filename=? AND size=? AND finalized=0",
            (checksum, filename, size),
        )
        row = cur.fetchone()
        if row:
            upload_id = row["id"]
            # Use the stored upload parameters so client and server agree on indices
            chunk_size = int(row["chunk_size"])
            total_chunks = int(row["total_chunks"])
            size = int(row["size"])
            # ensure staging dir exists
            (STAGING_DIR / upload_id).mkdir(parents=True, exist_ok=True)
        else:
            upload_id = uuid.uuid4().hex
            cur.execute(
                """
                INSERT INTO uploads (id, filename, size, chunk_size, total_chunks, checksum, finalized, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
                """,
                (upload_id, filename, size, chunk_size, total_chunks, checksum, now_iso(), now_iso()),
            )
            con.commit()
            (STAGING_DIR / upload_id).mkdir(parents=True, exist_ok=True)

        # ensure a stats row exists for this upload (idempotent)
        cur.execute(
            "INSERT OR IGNORE INTO upload_stats (upload_id) VALUES (?)",
            (upload_id,),
        )
        con.commit()
        # associate upload with current session cookie (if present)
        user_id = request.cookies.get("mf_user")
        if user_id:
            try:
                cur.execute("INSERT OR IGNORE INTO sessions (user_id) VALUES (?)", (user_id,))
                cur.execute("UPDATE sessions SET last_upload_id=? WHERE user_id=?", (upload_id, user_id))
                cur.execute("UPDATE uploads SET user_id=? WHERE id=?", (user_id, upload_id))
                con.commit()
            except Exception:
                con.rollback()

        # get received chunk indices
        cur.execute("SELECT idx FROM chunks WHERE upload_id=? ORDER BY idx", (upload_id,))
        got = [r[0] for r in cur.fetchall()]

    return jsonify(
        upload_id=upload_id,
        filename=filename,
        size=size,
        chunk_size=chunk_size,
        total_chunks=total_chunks,
        received_indices=got,
    )


@app.put("/upload/<upload_id>/<int:idx>")
def upload_chunk(upload_id: str, idx: int):
    req_start = time.time()  # measure request start
    # validate upload exists and params sane
    with _db_lock, db_connect() as con:
        cur = con.cursor()
        cur.execute("SELECT * FROM uploads WHERE id=?", (upload_id,))
        row = cur.fetchone()
        if not row:
            return jsonify(error="unknown-upload"), 404
        if row["finalized"]:
            return jsonify(error="already-finalized"), 409
        total = int(row["total_chunks"])
        if idx < 0 or idx >= total:
            return jsonify(error="bad-index", total_chunks=total), 400

    # ensure staging dir exists
    chunk_dir = STAGING_DIR / upload_id
    chunk_dir.mkdir(parents=True, exist_ok=True)
    chunk_path = chunk_dir / f"{idx:08d}.part"

    raw = request.get_data(cache=False, as_text=False)
    if not raw:
        return jsonify(error="empty-body"), 400

    # write chunk (overwrite allowed for idempotency)
    with open(chunk_path, "wb") as f:
        f.write(raw)
    req_end = time.time()  # measure request end

    # record in DB (idempotent) and update stats + record per-chunk event
    with _db_lock, db_connect() as con:
        cur = con.cursor()
        try:
            # check if we already had this chunk to avoid double-counting bytes
            cur.execute("SELECT 1 FROM chunks WHERE upload_id=? AND idx=?", (upload_id, idx))
            existed = cur.fetchone() is not None

            # record chunk presence
            cur.execute(
                "INSERT OR IGNORE INTO chunks (upload_id, idx, received_at) VALUES (?, ?, ?)",
                (upload_id, idx, now_iso()),
            )
            cur.execute(
                "UPDATE uploads SET updated_at=? WHERE id=?",
                (now_iso(), upload_id),
            )

            # ensure stats row exists
            cur.execute("INSERT OR IGNORE INTO upload_stats (upload_id) VALUES (?)", (upload_id,))
            cur.execute("SELECT * FROM upload_stats WHERE upload_id=?", (upload_id,))
            s = cur.fetchone()

            # per-chunk event (start/end/duration/bytes) - used by finalize sweep-line
            start_iso = datetime.utcfromtimestamp(req_start).isoformat(timespec="milliseconds") + "Z"
            end_iso = datetime.utcfromtimestamp(req_end).isoformat(timespec="milliseconds") + "Z"
            duration = max(0.0, req_end - req_start)
            cur.execute(
                "INSERT OR REPLACE INTO chunk_events (upload_id, idx, start_ts, end_ts, bytes, duration) VALUES (?, ?, ?, ?, ?, ?)",
                (upload_id, idx, start_iso, end_iso, len(raw), duration),
            )

            # update aggregated stats (avoid double-count when chunk already existed)
            bytes_prev = int(s["bytes_received"] or 0)
            bytes_new = bytes_prev + (0 if existed else len(raw))

            last_end = s["last_activity_end"]
            downtime = float(s["downtime_seconds"] or 0.0)
            active = float(s["upload_active_seconds"] or 0.0)

            # compute gap between previous activity end and this request start
            if last_end:
                try:
                    last_end_ts = datetime.fromisoformat(last_end.replace("Z", "")).timestamp()
                    gap = req_start - last_end_ts
                    # If gap > threshold, count as downtime; else count as active gap
                    if gap > DOWNTIME_THRESHOLD:
                        downtime += gap
                    else:
                        active += max(0.0, gap)
                except Exception:
                    # ignore parsing errors and continue
                    pass
            else:
                # first chunk case: mark first_chunk_at
                cur.execute("UPDATE upload_stats SET first_chunk_at=? WHERE upload_id=?", (now_iso(), upload_id))

            # add this request's duration to active time and update last_activity_end
            active += duration

            cur.execute(
                "UPDATE upload_stats SET bytes_received=?, last_activity_end=?, downtime_seconds=?, upload_active_seconds=? WHERE upload_id=?",
                (bytes_new, now_iso(), downtime, active, upload_id),
            )

            con.commit()
        except Exception as e:
            con.rollback()
            return jsonify(error="db-error", details=str(e)), 500

    return jsonify(ok=True)


@app.get("/status/<upload_id>")
def status(upload_id: str):
    with _db_lock, db_connect() as con:
        cur = con.cursor()
        cur.execute("SELECT * FROM uploads WHERE id=?", (upload_id,))
        row = cur.fetchone()
        if not row:
            return jsonify(error="unknown-upload"), 404
        total = int(row["total_chunks"])
        cur.execute("SELECT idx FROM chunks WHERE upload_id=? ORDER BY idx", (upload_id,))
        got = [r[0] for r in cur.fetchall()]

        # include basic stats if present
        cur.execute("SELECT * FROM upload_stats WHERE upload_id=?", (upload_id,))
        s = cur.fetchone()
        stats = None
        if s:
            upload_active = float(s["upload_active_seconds"] or 0.0)
            downtime = float(s["downtime_seconds"] or 0.0)
            bytes_received = int(s["bytes_received"] or 0)
            avg_bps = bytes_received / upload_active if upload_active > 0 else None

            # concurrency derived values
            peak_conc = int(s["peak_concurrency"] or 0)
            curr_conc = int(s["current_concurrency"] or 0)
            cum_conc = float(s["concurrency_cumulative_seconds"] or 0.0)
            avg_conc = cum_conc / upload_active if upload_active > 0 else (curr_conc or 0)

            stats = dict(
                bytes_received=bytes_received,
                upload_active_seconds=upload_active,
                downtime_seconds=downtime,
                assembly_seconds=float(s["assembly_seconds"] or 0.0),
                finalized_at=s["finalized_at"],
                avg_upload_bps=avg_bps,
                upload_start=s["upload_start"] or s["first_chunk_at"],
                upload_end=s["upload_end"] or s["last_activity_end"],
                peak_concurrency=peak_conc,
                current_concurrency=curr_conc,
                concurrency_cumulative_seconds=cum_conc,
                avg_concurrency=avg_conc,
            )

    missing = [i for i in range(total) if i not in set(got)]
    return jsonify(
        upload_id=upload_id,
        total_chunks=total,
        received=len(got),
        missing=missing,
        finalized=bool(row["finalized"]),
        updated_at=row["updated_at"],
        stats=stats,
    )


@app.post("/finalize/<upload_id>")
def finalize(upload_id: str):
    with _db_lock, db_connect() as con:
        cur = con.cursor()
        cur.execute("SELECT * FROM uploads WHERE id=?", (upload_id,))
        up = cur.fetchone()
        if not up:
            return jsonify(error="unknown-upload"), 404
        if up["finalized"]:
            return jsonify(ok=True, already=True)
        total = int(up["total_chunks"])
        chunk_size = int(up["chunk_size"])
        filename = up["filename"]
        checksum = up["checksum"]
        size = int(up["size"])
        chunk_dir = STAGING_DIR / upload_id

        # verify all chunks exist
        have = sorted(p for p in chunk_dir.glob("*.part"))
        if len(have) != total:
            return jsonify(error="incomplete", have=len(have), need=total), 409

        # assemble
        final_path = UPLOAD_DIR / filename
        tmp_path = final_path.with_suffix(final_path.suffix + ".assembling")
        h = hashlib.sha256()
        written = 0

        assembly_start = time.time()
        with open(tmp_path, "wb") as out:
            for i in range(total):
                p = chunk_dir / f"{i:08d}.part"
                with open(p, "rb") as f:
                    while True:
                        buf = f.read(1024 * 1024)
                        if not buf:
                            break
                        out.write(buf)
                        h.update(buf)
                        written += len(buf)
        assembly_end = time.time()
        assembly_seconds = max(0.0, assembly_end - assembly_start)

        calc = h.hexdigest()
        if written != size:
            tmp_path.unlink(missing_ok=True)
            return jsonify(error="size-mismatch", expected=size, got=written), 500

        if not (isinstance(checksum, str) and checksum.startswith("NOCHK:")):
            if calc.lower() != checksum.lower():
                tmp_path.unlink(missing_ok=True)
                return jsonify(error="checksum-mismatch", expected=checksum, got=calc), 422

        # move into place
        if final_path.exists():
            final_path = final_path.with_name(final_path.stem + f"-{upload_id}" + final_path.suffix)
        shutil.move(tmp_path, final_path)

        # mark finalized
        cur.execute("UPDATE uploads SET finalized=1, updated_at=? WHERE id=?", (now_iso(), upload_id))
        con.commit()

        # ensure stats row exists
        cur.execute("INSERT OR IGNORE INTO upload_stats (upload_id) VALUES (?)", (upload_id,))
        con.commit()

        # fetch per-chunk events to compute accurate timings & concurrency
        cur.execute("SELECT start_ts, end_ts FROM chunk_events WHERE upload_id=? ORDER BY start_ts", (upload_id,))
        rows = cur.fetchall()
        timestamps = []
        for r in rows:
            if not r["start_ts"] or not r["end_ts"]:
                continue
            try:
                st = datetime.fromisoformat(r["start_ts"].replace("Z", "")).timestamp()
                en = datetime.fromisoformat(r["end_ts"].replace("Z", "")).timestamp()
                if en < st:
                    en = st
                timestamps.append((st, en))
            except Exception:
                continue

        upload_start = None
        upload_end = None
        union_active = 0.0
        cum_conc = 0.0
        peak_conc = 0

        if timestamps:
            # sweep-line: build events (+1 at start, -1 at end)
            events = []
            for s_ts, e_ts in timestamps:
                events.append((s_ts, 1))
                events.append((e_ts, -1))
            events.sort()
            curr = 0
            last_t = events[0][0]
            upload_start = last_t
            for t, delta in events:
                if t > last_t:
                    interval = t - last_t
                    if curr > 0:
                        union_active += interval
                        cum_conc += curr * interval
                    last_t = t
                curr += delta
                if curr > peak_conc:
                    peak_conc = curr
            upload_end = last_t

        # derive downtime as span minus union_active (if we have a span)
        downtime = 0.0
        if upload_start is not None and upload_end is not None and upload_end >= upload_start:
            total_span = upload_end - upload_start
            downtime = max(0.0, total_span - union_active)

        avg_conc = (cum_conc / union_active) if union_active > 0 else None

        # update upload_stats with computed values
        cur.execute(
            """
            UPDATE upload_stats SET
              upload_start=?,
              upload_end=?,
              upload_active_seconds=?,
              concurrency_cumulative_seconds=?,
              peak_concurrency=?,
              downtime_seconds=?,
              assembly_seconds=?,
              finalized_at=?
            WHERE upload_id=?
            """,
            (
                datetime.utcfromtimestamp(upload_start).isoformat(timespec="milliseconds") + "Z" if upload_start else None,
                datetime.utcfromtimestamp(upload_end).isoformat(timespec="milliseconds") + "Z" if upload_end else None,
                union_active,
                cum_conc,
                peak_conc,
                downtime,
                assembly_seconds,
                now_iso(),
                upload_id,
            ),
        )
        con.commit()

        # fetch final stats to return
        cur.execute("SELECT * FROM upload_stats WHERE upload_id=?", (upload_id,))
        s = cur.fetchone()
        bytes_received = int(s["bytes_received"] or 0)
        upload_active = float(s["upload_active_seconds"] or 0.0)
        downtime = float(s["downtime_seconds"] or 0.0)
        cum_conc = float(s["concurrency_cumulative_seconds"] or 0.0)
        peak_conc = int(s["peak_concurrency"] or 0)
        avg_conc = cum_conc / upload_active if upload_active > 0 else None

        # update session last_upload_id so the client can find this upload on refresh
        user_id = request.cookies.get("mf_user")
        if user_id:
            try:
                cur.execute("INSERT OR IGNORE INTO sessions (user_id) VALUES (?)", (user_id,))
                cur.execute("UPDATE sessions SET last_upload_id=? WHERE user_id=?", (upload_id, user_id))
                con.commit()
            except Exception:
                con.rollback()

    # cleanup chunks asynchronously (existing trash/move logic follows)
    trash_dir = STAGING_DIR / "_trash"
    try:
        trash_dir.mkdir(exist_ok=True)
    except Exception:
        pass
    to_delete = trash_dir / f"{upload_id}-{int(time.time())}"
    try:
        os.replace(str(chunk_dir), str(to_delete))
    except Exception:
        try:
            shutil.move(str(chunk_dir), str(to_delete))
        except Exception:
            to_delete = chunk_dir if chunk_dir.exists() else None
    if to_delete and to_delete.exists():
        def _cleanup_async(path):
            try:
                shutil.rmtree(path)
            except Exception:
                pass
        threading.Thread(target=_cleanup_async, args=(str(to_delete),), daemon=True).start()

    return jsonify(
        ok=True,
        path=str(final_path),
        stats=dict(
            bytes_received=bytes_received,
            upload_active_seconds=upload_active,
            downtime_seconds=downtime,
            assembly_seconds=assembly_seconds,
            avg_upload_bps=(bytes_received / upload_active) if upload_active > 0 else None,
            peak_concurrency=peak_conc,
            avg_concurrency=avg_conc,
            concurrency_cumulative_seconds=cum_conc,
            upload_start=s["upload_start"],
            upload_end=s["upload_end"],
        ),
    )


@app.get("/downloads/<path:filename>")
def downloads(filename: str):
    # Serve a completed file back (optional utility)
    safe = sanitize_filename(filename)
    return send_from_directory(UPLOAD_DIR, safe, as_attachment=True)


@app.get("/session")
def get_session():
    """Return session info for cookie-identified client (last_upload_id and persisted logs)."""
    user_id = request.cookies.get("mf_user")
    if not user_id:
        return jsonify(user_id=None, last_upload_id=None, logs="")
    with _db_lock, db_connect() as con:
        cur = con.cursor()
        cur.execute("SELECT last_upload_id, logs FROM sessions WHERE user_id=?", (user_id,))
        r = cur.fetchone()
        if not r:
            # create empty session row
            cur.execute("INSERT OR IGNORE INTO sessions (user_id) VALUES (?)", (user_id,))
            con.commit()
            return jsonify(user_id=user_id, last_upload_id=None, logs="")
        return jsonify(user_id=user_id, last_upload_id=r["last_upload_id"], logs=r["logs"] or "")


@app.post("/session/log")
def append_session_log():
    """Append a short log entry to the server-stored session logs (keeps a bounded tail)."""
    user_id = request.cookies.get("mf_user")
    if not user_id:
        return jsonify(ok=False), 400
    data = request.get_json(force=True)
    msg = (data.get("log") or "").strip()
    if not msg:
        return jsonify(ok=False), 400
    with _db_lock, db_connect() as con:
        cur = con.cursor()
        cur.execute("INSERT OR IGNORE INTO sessions (user_id) VALUES (?)", (user_id,))
        cur.execute("SELECT logs FROM sessions WHERE user_id=?", (user_id,))
        old = cur.fetchone()
        tail = (old["logs"] or "") if old else ""
        # append and keep last 32KB to avoid unbounded growth
        new = (tail + msg + "\n")[-32768:]
        cur.execute("UPDATE sessions SET logs=? WHERE user_id=?", (new, user_id))
        con.commit()
    return jsonify(ok=True)


@app.get("/history")
def get_history():
    """Return uploads associated with this browser session plus files found in UPLOAD_DIR."""
    user_id = request.cookies.get("mf_user")
    uploads = []
    server_files = []
    with _db_lock, db_connect() as con:
        cur = con.cursor()
        if user_id:
            # uploads explicitly associated with this user
            cur.execute(
                "SELECT id AS upload_id, filename, size, chunk_size, total_chunks, finalized, created_at, updated_at FROM uploads WHERE user_id=? ORDER BY updated_at DESC",
                (user_id,),
            )
            for r in cur.fetchall():
                uploads.append(
                    {
                        "upload_id": r["upload_id"],
                        "filename": r["filename"],
                        "size": r["size"],
                        "chunk_size": r["chunk_size"],
                        "total_chunks": r["total_chunks"],
                        "finalized": bool(r["finalized"]),
                        "created_at": r["created_at"],
                        "updated_at": r["updated_at"],
                    }
                )
        # Also list any completed files present on disk (uploads table may not include external files)
        try:
            for p in UPLOAD_DIR.iterdir():
                if not p.is_file():
                    continue
                try:
                    st = p.stat()
                    server_files.append(
                        {
                            "filename": p.name,
                            "size": st.st_size,
                            "modified_at": datetime.utcfromtimestamp(st.st_mtime).isoformat(timespec="milliseconds") + "Z",
                            "path": f"/downloads/{p.name}",
                        }
                    )
                except Exception:
                    continue
        except Exception:
            pass
    return jsonify(uploads=uploads, server_files=server_files)


# --- Minimal single-page UI with chunked/resumable upload ---
with open("HTML/Index.html", "r", encoding="utf-8") as f:
  INDEX_HTML = f.read()


if __name__ == "__main__":
    db_init()
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "5000"))
    print(f"* Starting {APP_TITLE} on http://{host}:{port}")
    app.run(host=host, port=port, threaded=True)

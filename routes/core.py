# routes/core.py
from flask import Blueprint, Response, jsonify, make_response, render_template_string, request, send_from_directory
import hashlib
import os
import shutil
import threading
import time
import uuid
from datetime import datetime, timezone

from config import APP_TITLE, UPLOAD_DIR, STAGING_DIR, MAX_FILE_SIZE, CHUNK_SIZE_MAX, DOWNTIME_THRESHOLD
from db import db_connect, _db_lock
from utils import sanitize_filename, now_iso

bp = Blueprint("core", __name__)

# load index HTML file
try:
    with open("HTML/Index.html", "r", encoding="utf-8") as f:
        INDEX_HTML = f.read()
except Exception:
    INDEX_HTML = "<html><body><h1>Index.html missing</h1></body></html>"

@bp.get("/")
def index():
    # Create or preserve a browser cookie that identifies this client
    user_cookie = request.cookies.get("mf_user")
    if not user_cookie:
        user_cookie = uuid.uuid4().hex
    resp = make_response(render_template_string(INDEX_HTML, app_title=APP_TITLE, chunk_size_max=CHUNK_SIZE_MAX))
    # persistent cookie, HttpOnly
    resp.set_cookie("mf_user", user_cookie, max_age=30 * 24 * 3600, httponly=True)
    return resp

@bp.post("/initiate")
def initiate():
    data = request.get_json(force=True)
    filename = sanitize_filename(data.get("filename", ""))
    size = int(data.get("size", 0))
    chunk_size = int(data.get("chunk_size", 0))
    checksum = (data.get("checksum") or "").lower()

    if not filename or size <= 0 or chunk_size <= 0:
        return jsonify(error="invalid-params"), 400
    if not checksum:
        checksum = f"NOCHK:{filename}:{size}"

    if size > MAX_FILE_SIZE:
        return jsonify(error="file-too-large", max_bytes=MAX_FILE_SIZE), 413
    if chunk_size > CHUNK_SIZE_MAX:
        return jsonify(error="chunk-too-large", max_bytes=CHUNK_SIZE_MAX), 413

    total_chunks = (size + chunk_size - 1) // chunk_size

    with _db_lock, db_connect() as con:
        cur = con.cursor()
        cur.execute(
            "SELECT * FROM uploads WHERE checksum=? AND filename=? AND size=? AND finalized=0",
            (checksum, filename, size),
        )
        row = cur.fetchone()
        if row:
            upload_id = row["id"]
            chunk_size = int(row["chunk_size"])
            total_chunks = int(row["total_chunks"])
            size = int(row["size"])
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

        cur.execute("INSERT OR IGNORE INTO upload_stats (upload_id) VALUES (?)", (upload_id,))
        con.commit()

        user_id = request.cookies.get("mf_user")
        if user_id:
            try:
                cur.execute("INSERT OR IGNORE INTO sessions (user_id) VALUES (?)", (user_id,))
                cur.execute("UPDATE sessions SET last_upload_id=? WHERE user_id=?", (upload_id, user_id))
                cur.execute("UPDATE uploads SET user_id=? WHERE id=?", (user_id, upload_id))
                con.commit()
            except Exception:
                con.rollback()

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

@bp.put("/upload/<upload_id>/<int:idx>")
def upload_chunk(upload_id: str, idx: int):
    req_start = time.time()
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

    chunk_dir = STAGING_DIR / upload_id
    chunk_dir.mkdir(parents=True, exist_ok=True)
    chunk_path = chunk_dir / f"{idx:08d}.part"

    raw = request.get_data(cache=False, as_text=False)
    if not raw:
        return jsonify(error="empty-body"), 400

    with open(chunk_path, "wb") as f:
        f.write(raw)
    req_end = time.time()

    with _db_lock, db_connect() as con:
        cur = con.cursor()
        try:
            cur.execute("SELECT 1 FROM chunks WHERE upload_id=? AND idx=?", (upload_id, idx))
            existed = cur.fetchone() is not None

            cur.execute(
                "INSERT OR IGNORE INTO chunks (upload_id, idx, received_at) VALUES (?, ?, ?)",
                (upload_id, idx, now_iso()),
            )
            cur.execute("UPDATE uploads SET updated_at=? WHERE id=?", (now_iso(), upload_id))

            cur.execute("INSERT OR IGNORE INTO upload_stats (upload_id) VALUES (?)", (upload_id,))
            cur.execute("SELECT * FROM upload_stats WHERE upload_id=?", (upload_id,))
            s = cur.fetchone()

            start_iso = datetime.fromtimestamp(req_start, timezone.utc).isoformat(timespec="milliseconds").replace('+00:00', 'Z')
            end_iso = datetime.fromtimestamp(req_end, timezone.utc).isoformat(timespec="milliseconds").replace('+00:00', 'Z')
            duration = max(0.0, req_end - req_start)
            cur.execute(
                "INSERT OR REPLACE INTO chunk_events (upload_id, idx, start_ts, end_ts, bytes, duration) VALUES (?, ?, ?, ?, ?, ?)",
                (upload_id, idx, start_iso, end_iso, len(raw), duration),
            )

            bytes_prev = int(s["bytes_received"] or 0)
            bytes_new = bytes_prev + (0 if existed else len(raw))

            last_end = s["last_activity_end"]
            downtime = float(s["downtime_seconds"] or 0.0)
            active = float(s["upload_active_seconds"] or 0.0)

            if last_end:
                try:
                    last_end_ts = datetime.fromisoformat(last_end.replace("Z", "")).timestamp()
                    gap = req_start - last_end_ts
                    if gap > DOWNTIME_THRESHOLD:
                        downtime += gap
                    else:
                        active += max(0.0, gap)
                except Exception:
                    pass
            else:
                cur.execute("UPDATE upload_stats SET first_chunk_at=? WHERE upload_id=?", (now_iso(), upload_id))

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

@bp.get("/status/<upload_id>")
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

        cur.execute("SELECT * FROM upload_stats WHERE upload_id=?", (upload_id,))
        s = cur.fetchone()
        stats = None
        if s:
            upload_active = float(s["upload_active_seconds"] or 0.0)
            downtime = float(s["downtime_seconds"] or 0.0)
            bytes_received = int(s["bytes_received"] or 0)
            avg_bps = bytes_received / upload_active if upload_active > 0 else None

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

@bp.post("/finalize/<upload_id>")
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

        have = sorted(p for p in chunk_dir.glob("*.part")) if chunk_dir.exists() else []
        if len(have) != total:
            return jsonify(error="incomplete", have=len(have), need=total), 409

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

        if final_path.exists():
            final_path = final_path.with_name(final_path.stem + f"-{upload_id}" + final_path.suffix)
        shutil.move(tmp_path, final_path)

        cur.execute("UPDATE uploads SET finalized=1, updated_at=? WHERE id=?", (now_iso(), upload_id))
        con.commit()

        cur.execute("INSERT OR IGNORE INTO upload_stats (upload_id) VALUES (?)", (upload_id,))
        con.commit()

        # compute per-chunk timing/concurrency using chunk_events
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

        downtime = 0.0
        if upload_start is not None and upload_end is not None and upload_end >= upload_start:
            total_span = upload_end - upload_start
            downtime = max(0.0, total_span - union_active)

        avg_conc = (cum_conc / union_active) if union_active > 0 else None

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
                datetime.fromtimestamp(upload_start, timezone.utc).isoformat(timespec="milliseconds").replace('+00:00', 'Z') if upload_start else None,
                datetime.fromtimestamp(upload_end, timezone.utc).isoformat(timespec="milliseconds").replace('+00:00', 'Z') if upload_end else None,
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

        cur.execute("SELECT * FROM upload_stats WHERE upload_id=?", (upload_id,))
        s = cur.fetchone()
        bytes_received = int(s["bytes_received"] or 0)
        upload_active = float(s["upload_active_seconds"] or 0.0)
        downtime = float(s["downtime_seconds"] or 0.0)
        cum_conc = float(s["concurrency_cumulative_seconds"] or 0.0)
        peak_conc = int(s["peak_concurrency"] or 0)
        avg_conc = cum_conc / upload_active if upload_active > 0 else None

        user_id = request.cookies.get("mf_user")
        if user_id:
            try:
                cur.execute("INSERT OR IGNORE INTO sessions (user_id) VALUES (?)", (user_id,))
                cur.execute("UPDATE sessions SET last_upload_id=? WHERE user_id=?", (upload_id, user_id))
                con.commit()
            except Exception:
                con.rollback()

    # cleanup chunks asynchronously
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

@bp.get("/downloads/<path:filename>")
def downloads(filename: str):
    safe = sanitize_filename(filename)
    return send_from_directory(UPLOAD_DIR, safe, as_attachment=True)

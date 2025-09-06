# routes/session.py
from flask import Blueprint, jsonify, request

from db import db_connect, _db_lock
from utils import now_iso

bp = Blueprint("session", __name__)

@bp.get("/session")
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
            cur.execute("INSERT OR IGNORE INTO sessions (user_id) VALUES (?)", (user_id,))
            con.commit()
            return jsonify(user_id=user_id, last_upload_id=None, logs="")
        return jsonify(user_id=user_id, last_upload_id=r["last_upload_id"], logs=r["logs"] or "")

@bp.post("/session/log")
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
        new = (tail + msg + "\n")[-32768:]
        cur.execute("UPDATE sessions SET logs=? WHERE user_id=?", (new, user_id))
        con.commit()
    return jsonify(ok=True)

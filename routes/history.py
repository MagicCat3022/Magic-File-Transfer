# routes/history.py
from flask import Blueprint, jsonify, request
from datetime import datetime, timezone

from db import db_connect, _db_lock
from config import UPLOAD_DIR

bp = Blueprint("history", __name__)

@bp.get("/history")
def get_history():
    """Return uploads associated with this browser session plus files found in UPLOAD_DIR."""
    user_id = request.cookies.get("mf_user")
    uploads = []
    server_files = []
    with _db_lock, db_connect() as con:
        cur = con.cursor()
        if user_id:
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
                            "modified_at": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(timespec="milliseconds").replace('+00:00', 'Z'),
                            "path": f"/downloads/{p.name}",
                        }
                    )
                except Exception:
                    continue
        except Exception:
            pass
    return jsonify(uploads=uploads, server_files=server_files)

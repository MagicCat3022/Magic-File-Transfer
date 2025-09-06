# utils.py
import uuid
from datetime import datetime, timezone
from werkzeug.utils import secure_filename

def sanitize_filename(name: str) -> str:
    """Wrap secure_filename and ensure non-empty, bounded length result."""
    base = secure_filename(name or "")
    return base[:255] if base else f"upload-{uuid.uuid4().hex}"

def now_iso() -> str:
    """UTC ISO timestamp with millisecond precision and trailing Z."""
    # Use timezone-aware formatting to avoid accidental local tz
    return datetime.utcnow().replace(tzinfo=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

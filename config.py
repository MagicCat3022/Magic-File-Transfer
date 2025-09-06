# config.py
from pathlib import Path

APP_TITLE = "LAN File Drop"

UPLOAD_DIR = Path("uploads")
STAGING_DIR = Path("staging")
DB_PATH = Path("db/filedrop.db")

MAX_FILE_SIZE = 50 * 1024 * 1024 * 1024  # 50 GiB
CHUNK_SIZE_MAX = 64 * 1024 * 1024        # 64 MiB per chunk
DOWNTIME_THRESHOLD = 2.0                 # seconds: gaps longer than this count as downtime

# Ensure directories exist
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
STAGING_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

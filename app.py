# app.py
from flask import Flask
import os

from config import CHUNK_SIZE_MAX, APP_TITLE
from db import db_init
from routes import register_routes

app = Flask(__name__)
# allow some header overhead beyond chunk max
app.config.update(MAX_CONTENT_LENGTH=CHUNK_SIZE_MAX + 1024 * 1024)

# register all blueprints
register_routes(app)

if __name__ == "__main__":
    db_init()
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "5000"))
    print(f"* Starting {APP_TITLE} on http://{host}:{port}")
    app.run(host=host, port=port, threaded=True)

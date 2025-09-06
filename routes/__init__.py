# routes/__init__.py
from .core import bp as core_bp
from .session import bp as session_bp
from .history import bp as history_bp

def register_routes(app):
    app.register_blueprint(core_bp)
    app.register_blueprint(session_bp)
    app.register_blueprint(history_bp)

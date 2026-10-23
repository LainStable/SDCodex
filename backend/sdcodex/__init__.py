"""SDCodex backend package (Flask + SQLAlchemy, SQLite)."""

import os
import secrets
import sqlite3

from flask import Flask, jsonify, request
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlalchemy.pool import NullPool

db = SQLAlchemy()

# Register the SQLite pragma listener once per process (create_app can be
# called more than once by tests).
_PRAGMAS_INSTALLED = False


def _database_path(db_path: str | None) -> str:
    default_db = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "data", "sdcodex.db"
    )
    if db_path:
        return os.path.abspath(db_path)
    configured = (os.environ.get("DATABASE_URL") or "").strip()
    if configured.startswith("sqlite:///"):
        return os.path.abspath(configured[len("sqlite:///") :])
    return os.path.abspath(default_db)


def _secret_key(db_file: str) -> str:
    """Stable secret from the environment, or a generated file beside the DB.

    A hard-coded fallback would let anyone forge session cookies, so when
    ``SECRET_KEY`` is unset we persist a random key with owner-only permissions.
    """
    configured = (os.environ.get("SECRET_KEY") or "").strip()
    if configured:
        return configured
    path = (os.environ.get("SDCODEX_SECRET_FILE") or "").strip()
    if not path:
        path = os.path.join(os.path.dirname(db_file) or ".", ".secret_key")
    try:
        with open(path, encoding="utf-8") as handle:
            stored = handle.read().strip()
        if stored:
            return stored
    except FileNotFoundError:
        pass
    except (OSError, UnicodeDecodeError):
        return secrets.token_hex(32)
    key = secrets.token_hex(32)
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(key)
    except OSError:
        # Read-only install: a per-process key still beats a public constant.
        pass
    return key


def _install_sqlite_pragmas() -> None:
    global _PRAGMAS_INSTALLED
    if _PRAGMAS_INSTALLED:
        return
    _PRAGMAS_INSTALLED = True

    @event.listens_for(Engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection, _connection_record):  # noqa: ANN001
        if not isinstance(dbapi_connection, sqlite3.Connection):
            return
        cursor = dbapi_connection.cursor()
        try:
            # WAL keeps readers from blocking the background download/scan
            # workers, and busy_timeout avoids the transient "database is
            # locked" 500s under concurrent writes.
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA busy_timeout=30000")
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA synchronous=NORMAL")
        except sqlite3.Error:
            pass
        finally:
            cursor.close()


def _ensure_user_theme_column(app) -> None:
    """`db.create_all()` never alters an existing table, so add the per-user
    theme column to older databases instead of losing saved choices."""
    try:
        from sqlalchemy import inspect, text

        columns = {c["name"] for c in inspect(db.engine).get_columns("users")}
        if "theme" in columns:
            return
        with db.engine.begin() as conn:
            conn.execute(text("ALTER TABLE users ADD COLUMN theme VARCHAR(64)"))
    except Exception:
        app.logger.warning("Could not add users.theme column", exc_info=True)


def _ensure_download_base_model_column(app) -> None:
    """Same idea for Download rows: the library card shows the base model
    (SDXL, Illustrious, Flux…) instead of the old socket state."""
    try:
        from sqlalchemy import inspect, text

        columns = {c["name"] for c in inspect(db.engine).get_columns("download")}
        if "base_model" in columns:
            return
        with db.engine.begin() as conn:
            conn.execute(text("ALTER TABLE download ADD COLUMN base_model VARCHAR(64)"))
    except Exception:
        app.logger.warning("Could not add download.base_model column", exc_info=True)


def create_app(db_path: str | None = None) -> Flask:
    app = Flask(__name__)
    db_file = _database_path(db_path)
    os.makedirs(os.path.dirname(db_file), exist_ok=True)

    app.config["SECRET_KEY"] = _secret_key(db_file)
    # Bound request bodies so a malformed upload cannot exhaust memory. The
    # GalleryDL backup restore accepts files up to 200 MB, so this stays above
    # that; override with SDCODEX_MAX_UPLOAD_MB when needed.
    try:
        max_upload_mb = int(os.environ.get("SDCODEX_MAX_UPLOAD_MB", "256"))
    except (TypeError, ValueError):
        max_upload_mb = 256
    app.config["MAX_CONTENT_LENGTH"] = max(1, max_upload_mb) * 1024 * 1024
    app.config["SQLALCHEMY_DATABASE_URI"] = (
        os.environ.get("DATABASE_URL") or f"sqlite:///{db_file}"
    )
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {
        "poolclass": NullPool,
        "connect_args": {"timeout": 30, "check_same_thread": False},
    }

    _install_sqlite_pragmas()
    db.init_app(app)

    @app.after_request
    def _security_headers(response):  # noqa: ANN001
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault(
            "Permissions-Policy", "camera=(), microphone=(), geolocation=()"
        )
        if request.path.startswith(
            ("/api/auth", "/api/profile", "/api/mcp", "/api/settings", "/api/oidc")
        ):
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    @app.errorhandler(413)
    def _too_large(_error):  # noqa: ANN001
        return jsonify({"error": "request body too large"}), 413

    from . import models  # noqa: F401  (register tables)
    from .api_v1 import api_v1

    app.register_blueprint(api_v1, url_prefix="/api")

    # Serve the built frontend in Docker from /srv/frontend (outside the
    # repo mount, which would mask anything baked under /app). Dev keeps
    # using Vite; bare-metal can drop a build into backend/sdcodex/static/.
    from flask import send_from_directory

    candidates = [
        "/srv/frontend",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "static"),
    ]
    static_dir = next(
        (c for c in candidates if os.path.exists(os.path.join(c, "index.html"))),
        "",
    )
    if static_dir:
        @app.route("/", defaults={"path": ""})
        @app.route("/<path:path>")
        def _frontend(path):
            if path.startswith("api/"):
                return {"error": "not found"}, 404
            full = os.path.join(static_dir, path)
            if path and os.path.isfile(full):
                return send_from_directory(static_dir, path)
            return send_from_directory(static_dir, "index.html")

    with app.app_context():
        db.create_all()
        _ensure_user_theme_column(app)
        _ensure_download_base_model_column(app)

    # Installed plugins (entrypoint init is optional; page-only plugins skip).
    try:
        from .updater import load_plugins, start_plugin_probe

        load_plugins(app)
        # Warm the remote-update cache right away instead of on the first
        # /api/plugins request after a restart (that request is what used to
        # hang, making installed plugins look missing).
        start_plugin_probe()
    except Exception:
        app.logger.warning("Plugin loader failed", exc_info=True)

    # Background worker for downloads + library scans.
    from .download_manager import download_manager

    download_manager.init_app(app)

    return app

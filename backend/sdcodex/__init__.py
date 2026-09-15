"""SDCodex backend package (Flask + SQLAlchemy, SQLite)."""

import os

from flask import Flask
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()


def create_app(db_path: str | None = None) -> Flask:
    app = Flask(__name__)
    app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY") or "dev-only-change-me"
    default_db = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "sdcodex.db")
    os.makedirs(os.path.dirname(os.path.abspath(default_db)), exist_ok=True)
    app.config["SQLALCHEMY_DATABASE_URI"] = (
        os.environ.get("DATABASE_URL") or f"sqlite:///{os.path.abspath(db_path or default_db)}"
    )
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

    db.init_app(app)

    from . import models  # noqa: F401  (register tables)
    from .api_v1 import api_v1

    app.register_blueprint(api_v1, url_prefix="/api")

    with app.app_context():
        db.create_all()

    # Background worker for downloads + library scans.
    from .download_manager import download_manager

    download_manager.init_app(app)

    return app

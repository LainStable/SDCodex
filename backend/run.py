import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sdcodex import create_app

app = create_app()


def list_users():
    from sdcodex.models import User

    with app.app_context():
        rows = User.query.order_by(User.id).all()
        if not rows:
            print("No users in database (bootstrap mode).")
            return
        for u in rows:
            print(f"#{u.id} {u.username} admin={bool(u.is_admin)} provider={u.auth_provider}")


def reset_admin(username: str, password: str):
    """Create or reset a local admin (recovery hatch — run on the server)."""
    from sdcodex import auth, db
    from sdcodex.models import User

    if len(password) < 8:
        print("Password must be at least 8 characters.")
        sys.exit(1)
    with app.app_context():
        user = User.query.filter_by(username=username.strip()).first()
        if user is None:
            user = User(
                username=username.strip(),
                display_name=username.strip(),
                auth_provider="local",
                is_admin=True,
                is_active=True,
            )
            db.session.add(user)
            print(f"Created admin '{user.username}'.")
        else:
            user.auth_provider = "local"
            user.is_active = True
            user.is_admin = True
            print(f"Reset '{user.username}' to local admin.")
        user.password_hash = auth.hash_password(password)
        db.session.commit()
        print("Password set. Sign in with it.")


if __name__ == "__main__":
    if "--list-users" in sys.argv:
        list_users()
    elif "--reset-admin" in sys.argv:
        i = sys.argv.index("--reset-admin")
        try:
            username, password = sys.argv[i + 1], sys.argv[i + 2]
        except IndexError:
            print("Usage: python run.py --reset-admin <username> <new-password>")
            sys.exit(2)
        reset_admin(username, password)
    else:
        # 0.0.0.0 by default so reverse proxies (OIDC redirect URIs) can reach it.
        # Override with HOST=127.0.0.1 for local-only.
        host = os.environ.get("HOST", "0.0.0.0")
        port = int(os.environ.get("PORT", "5000"))
        try:
            # A production WSGI server. The Flask dev server is single-process
            # and has no per-connection timeouts, which made long-running
            # downloads and SSE streams fragile. Waitress keeps one process
            # (the download/scan workers live in-process by design) with a
            # thread pool.
            from waitress import serve

            try:
                # Plugin pages (SSE streams, thumbnails, task polls) plus the
                # core's own polling can easily exceed a small pool: with 8
                # threads waitress logged "Task queue depth is 58" and pages
                # stalled. Default higher; SDCODEX_THREADS still overrides.
                threads = max(8, min(128, int(os.environ.get("SDCODEX_THREADS", "48"))))
            except (TypeError, ValueError):
                threads = 48
            try:
                # Browsers keep several keep-alive sockets per tab and plugin
                # iframes multiply that; the old 40-minute channel timeout let
                # idle sockets pile up until waitress hit its default 100-open
                # connection limit and stopped accepting requests.
                connection_limit = max(64, min(2000, int(os.environ.get("SDCODEX_CONNECTION_LIMIT", "256"))))
            except (TypeError, ValueError):
                connection_limit = 256
            try:
                channel_timeout = max(30, int(os.environ.get("SDCODEX_CHANNEL_TIMEOUT", "120")))
            except (TypeError, ValueError):
                channel_timeout = 120
            print(f"Serving with waitress on http://{host}:{port}", flush=True)
            serve(
                app,
                host=host,
                port=port,
                threads=threads,
                # Idle keep-alive channels only; active requests (updates, SSE
                # streams) are not closed by this timeout.
                channel_timeout=channel_timeout,
                connection_limit=connection_limit,
                ident="SDCodex",
            )
        except ImportError:
            app.run(host=host, port=port)

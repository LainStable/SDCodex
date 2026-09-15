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
        app.run(
            host=os.environ.get("HOST", "0.0.0.0"),
            port=int(os.environ.get("PORT", "5000")),
        )

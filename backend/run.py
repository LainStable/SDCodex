import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sdcodex import create_app

app = create_app()

if __name__ == "__main__":
    # 0.0.0.0 by default so reverse proxies (OIDC redirect URIs) can reach it.
    # Override with HOST=127.0.0.1 for local-only.
    app.run(
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "5000")),
    )

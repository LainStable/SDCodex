import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sdcodex import create_app

app = create_app()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")))

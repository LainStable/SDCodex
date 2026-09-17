# SDCodex — full stack in one image.
#
# Stage 1 builds the React frontend; stage 2 serves it plus the Flask API.
# Model dirs, DB, plugins and git state live in volumes so updates
# (`git pull` core/plugins) survive rebuilds.

FROM node:22-slim AS frontend
WORKDIR /build
COPY app/package.json app/package-lock.json ./app/
RUN cd app && npm ci --no-audit --no-fund
COPY app ./app
RUN cd app && npm run build

FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install -r backend/requirements.txt

COPY backend ./backend

# Frontend build output is served by Flask (see sdcodex.register_frontend).
COPY --from=frontend /build/app/dist ./backend/static/

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 5000

ENTRYPOINT ["/entrypoint.sh"]

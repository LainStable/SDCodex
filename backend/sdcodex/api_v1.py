"""JSON API for the React frontend. Mirrors OldCode routes.py semantics."""

import os
import re
import threading
import json
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlencode, urljoin, urlparse

import requests
from flask import Blueprint, Response, jsonify, make_response, request

from . import auth, db
from .models import Download, OidcConfig, PluginRepo, Setting, User

api_v1 = Blueprint("api_v1", __name__)

# How long a remote image may be, and how much of it we will buffer.
_MAX_IMAGE_BYTES = 25 * 1024 * 1024
_CIVITAI_HOST_SUFFIXES = (".civitai.com", ".civitai.red")
_CIVITAI_HOSTS = {"civitai.com", "civitai.red"}


def _civitai_host_ok(host: str | None) -> bool:
    host = (host or "").lower().rstrip(".")
    return host in _CIVITAI_HOSTS or any(host.endswith(s) for s in _CIVITAI_HOST_SUFFIXES)


def _civitai_get(url: str, headers: dict, *, timeout=(5, 30), max_redirects: int = 3):
    """GET a Civitai URL without following redirects to arbitrary hosts.

    The backend is often reachable only from the local network, so blind
    redirect following turns an image proxy into an SSRF primitive. Validate
    every hop before connecting.
    """
    current = url
    for _ in range(max_redirects + 1):
        parsed = urlparse(current)
        if (
            parsed.scheme != "https"
            or not _civitai_host_ok(parsed.hostname)
            or parsed.port not in (None, 443)
            or parsed.username
            or parsed.password
        ):
            raise ValueError("URL must be an HTTPS Civitai address")
        response = requests.get(
            current, headers=headers, timeout=timeout, stream=True, allow_redirects=False
        )
        if response.status_code in (301, 302, 303, 307, 308):
            location = response.headers.get("Location") or ""
            response.close()
            if not location:
                raise ValueError("Civitai returned an empty redirect")
            current = urljoin(current, location)
            continue
        return response
    raise ValueError("Too many redirects")


def _read_capped(response, limit: int) -> bytes:
    """Read a streamed response while enforcing an upper bound."""
    body = bytearray()
    for chunk in response.iter_content(chunk_size=128 * 1024):
        if not chunk:
            continue
        body.extend(chunk)
        if len(body) > limit:
            raise ValueError("upstream response too large")
    return bytes(body)


_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")


def _clean_env_value(value: str) -> str:
    """Reject values that could inject extra .env / compose lines."""
    value = (value or "").strip()
    if any(ch in value for ch in "\r\n\x00"):
        raise ValueError("value must not contain newlines")
    if len(value) > 1024:
        raise ValueError("value is too long")
    return value



def _user_json(u: User) -> dict:
    return {
        "id": u.id,
        "username": u.username,
        "displayName": u.display_name or u.username,
        "email": u.email or "",
        "isAdmin": bool(u.is_admin),
        "authProvider": u.auth_provider,
        "avatar": bool(u.avatar),
        "theme": u.theme or "",
    }


def _profile_json(u: User) -> dict:
    out = _user_json(u)
    out["avatarData"] = u.avatar or ""
    return out


def _clean_theme(value) -> str | None:
    """Theme slugs are CSS-class safe; anything else is rejected."""
    text = str(value or "").strip()
    if not text:
        return ""
    if len(text) > 64 or not all(ch.isalnum() or ch in "-_" for ch in text):
        return None
    return text


def _require_user():
    user = auth.current_user()
    if user is None:
        return None, (jsonify({"error": "unauthorized"}), 401)
    return user, None


# ---------------------------------------------------------------- health ---

@api_v1.get("/health")
def health():
    from . import updater as updater_mod

    return jsonify({"ok": True, "app": "sdcodex", "backend": True, "version": updater_mod.local_core_version()})


# ----------------------------------------------------------------- auth ---

@api_v1.get("/auth/status")
def auth_status():
    user = auth.current_user()
    return jsonify(
        {
            "authed": user is not None,
            "authEnabled": True,
            "bootstrap": User.query.count() == 0,
            "user": _user_json(user) if user else None,
        }
    )


_BOOTSTRAP_LOCK = threading.Lock()


@api_v1.post("/auth/bootstrap")
def auth_bootstrap():
    """Create the first user (admin). Refused once any user exists."""
    key = auth.login_key("__bootstrap__")
    if auth.rate_limited(key):
        return jsonify({"error": "too many attempts, try again later"}), 429
    data = request.get_json(force=True, silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    display = (data.get("displayName") or "").strip() or username
    theme = _clean_theme(data.get("theme"))
    if not username:
        return jsonify({"error": "username required"}), 400
    if len(password) < 8:
        return jsonify({"error": "password must be at least 8 characters"}), 400
    # Serialize the check + insert: two simultaneous first-run requests could
    # otherwise both see an empty users table and create two admins.
    with _BOOTSTRAP_LOCK:
        if User.query.count() > 0:
            return jsonify({"error": "users already exist"}), 403
        user = User(
            username=username,
            display_name=display,
            password_hash=auth.hash_password(password),
            auth_provider="local",
            is_admin=True,
            is_active=True,
            theme=theme or None,
        )
        db.session.add(user)
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
            auth.record_failed(key)
            return jsonify({"error": "could not create the first user"}), 500
    auth.clear_failures(key)
    token = auth.create_session(user.id, "local")
    resp = make_response(jsonify({"ok": True, "user": _user_json(user)}))
    auth.set_session_cookie(resp, token)
    return resp


@api_v1.post("/auth/login")
def auth_login():
    data = request.get_json(force=True, silent=True) or {}
    key = auth.login_key(str(data.get("username") or ""))
    if auth.rate_limited(key):
        return jsonify({"error": "too many attempts, try again later"}), 429
    result = auth.authenticate_local(data.get("username"), data.get("password"))
    if not result.get("success"):
        auth.record_failed(key)
        return jsonify({"error": result.get("error", "login failed")}), 401
    auth.clear_failures(key)
    user = result["user"]
    token = auth.create_session(user.id, "local")
    resp = make_response(jsonify({"ok": True, "user": _user_json(user)}))
    auth.set_session_cookie(resp, token)
    return resp


@api_v1.post("/auth/logout")
def auth_logout():
    auth.destroy_session(auth.get_session_token_from_request())
    resp = make_response(jsonify({"ok": True}))
    auth.clear_session_cookie(resp)
    return resp


@api_v1.get("/profile")
def get_profile():
    user, err = _require_user()
    if err:
        return err
    return jsonify(_profile_json(user))


@api_v1.put("/profile")
def put_profile():
    user, err = _require_user()
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    if "displayName" in data:
        user.display_name = (data.get("displayName") or "").strip()[:128] or user.username
    if "email" in data:
        user.email = (data.get("email") or "").strip()[:254]
    if "avatar" in data:
        avatar = data.get("avatar") or ""
        if len(avatar) > 300_000:
            return jsonify({"error": "avatar too large"}), 400
        user.avatar = avatar
    if "theme" in data:
        theme = _clean_theme(data.get("theme"))
        if theme is None:
            return jsonify({"error": "invalid theme"}), 400
        user.theme = theme or None
    db.session.commit()
    return jsonify({"ok": True, "user": _profile_json(user)})


# ------------------------------------------------------------- settings ---

@api_v1.get("/settings")
def get_settings():
    user, err = _require_user()
    if err:
        return err
    rows = {s.key: (s.value or "") for s in Setting.query.all()}
    try:
        max_parallel = int(rows.get("max_parallel_downloads", "1") or 1)
    except (TypeError, ValueError):
        max_parallel = 1
    return jsonify(
        {
            "dirs": {k: v for k, v in rows.items() if k.startswith("dir_")},
            "colors": {k[6:]: v for k, v in rows.items() if k.startswith("color_")},
            "civitaiApiKey": user.api_key
            or (rows.get("civitai_api_key", "") if user.is_admin else ""),
            "apiMirror": rows.get("api_mirror", "civitai.com") or "civitai.com",
            "organizeByBase": rows.get("organize_by_base", "0") == "1",
            "stabilitymatrix": rows.get("stabilitymatrix", "0") == "1",
            "maxParallel": max(1, min(16, max_parallel)),
        }
    )


@api_v1.post("/settings")
def post_settings():
    user, err = _require_user()
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    # Per-user values are always allowed; instance-wide configuration is an
    # admin action (otherwise any account could repoint model directories).
    # Non-admins keep saving their own API key; global keys are ignored.
    global_keys = ("dirs", "colors", "apiMirror", "maxParallel", "organizeByBase")
    if not user.is_admin:
        data = {k: v for k, v in data.items() if k not in global_keys}
    for key, value in (data.get("dirs") or {}).items():
        if not isinstance(key, str) or not key.startswith("dir_") or len(key) > 64:
            continue
        if not isinstance(value, str):
            continue
        row = db.session.get(Setting, key)
        if row is None:
            row = Setting(key=key)
            db.session.add(row)
        row.value = value.strip()[:1024]
    for type_name, value in (data.get("colors") or {}).items():
        if not isinstance(type_name, str) or not isinstance(value, str):
            continue
        key = f"color_{type_name}"[:64]
        row = db.session.get(Setting, key)
        if row is None:
            row = Setting(key=key)
            db.session.add(row)
        row.value = value.strip()[:32]
    if "civitaiApiKey" in data:
        key = (data.get("civitaiApiKey") or "").strip()
        user.api_key = key  # per-user, mirrors OldCode
        # The instance-wide fallback key is admin-owned. A normal account's key
        # must not silently become the key every download uses.
        if user.is_admin:
            row = db.session.get(Setting, "civitai_api_key")
            if row is None:
                row = Setting(key="civitai_api_key")
                db.session.add(row)
            row.value = key
    if "maxParallel" in data:
        try:
            parallel = max(1, min(8, int(data.get("maxParallel") or 1)))
        except (TypeError, ValueError):
            parallel = 1
        row = db.session.get(Setting, "max_parallel_downloads")
        if row is None:
            row = Setting(key="max_parallel_downloads")
            db.session.add(row)
        row.value = str(parallel)
    if "apiMirror" in data:
        mirror = data.get("apiMirror")
        mirror = mirror if mirror in ("civitai.com", "civitai.red") else "civitai.com"
        row = db.session.get(Setting, "api_mirror")
        if row is None:
            row = Setting(key="api_mirror")
            db.session.add(row)
        row.value = mirror
    if "organizeByBase" in data:
        row = db.session.get(Setting, "organize_by_base")
        if row is None:
            row = Setting(key="organize_by_base")
            db.session.add(row)
        row.value = "1" if data.get("organizeByBase") else "0"
    if "stabilitymatrix" in data:
        row = db.session.get(Setting, "stabilitymatrix")
        if row is None:
            row = Setting(key="stabilitymatrix")
            db.session.add(row)
        row.value = "1" if data.get("stabilitymatrix") else "0"
    db.session.commit()
    try:
        from .download_manager import download_manager

        download_manager.ensure_workers()
    except Exception:
        pass
    return jsonify({"ok": True})


# ------------------------------------------------------------ downloads ---

@api_v1.post("/downloads")
def add_download():
    user, err = _require_user()
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    try:
        model_id = int(data.get("modelId"))
        version_id = int(data.get("versionId"))
    except (TypeError, ValueError):
        return jsonify({"error": "modelId and versionId must be integers"}), 400
    from .download_manager import download_manager

    task = download_manager.add_task(
        model_id=model_id,
        version_id=version_id,
        api_key=user.api_key or None,
    )
    return jsonify(
        {
            "ok": True,
            "task": {
                "modelId": task.get("model_id"),
                "versionId": task.get("version_id"),
                "status": task.get("status"),
            },
        }
    )


@api_v1.get("/downloads/status")
def downloads_status():
    user, err = _require_user()
    if err:
        return err
    from .download_manager import download_manager

    return jsonify(download_manager.get_status())


def _download_key(data):
    try:
        return int(data.get("modelId")), int(data.get("versionId"))
    except (TypeError, ValueError):
        return None


@api_v1.post("/downloads/pause")
def downloads_pause():
    """Park one download (queued or running) without losing its definition."""
    user, err = _require_user()
    if err:
        return err
    key = _download_key(request.get_json(force=True, silent=True) or {})
    if key is None:
        return jsonify({"error": "modelId and versionId must be integers"}), 400
    from .download_manager import download_manager

    ok, msg = download_manager.pause_task(*key)
    return jsonify({"ok": ok, "message": msg}), (200 if ok else 404)


@api_v1.post("/downloads/start")
def downloads_start():
    """Resume/start a download. `force` bypasses the parallel limit."""
    user, err = _require_user()
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    key = _download_key(data)
    if key is None:
        return jsonify({"error": "modelId and versionId must be integers"}), 400
    from .download_manager import download_manager

    force = data.get("force", True) is not False
    ok, msg, _task = download_manager.start_task(
        key[0], key[1], api_key=user.api_key or None, force=force
    )
    return jsonify({"ok": ok, "message": msg}), (200 if ok else 404)


@api_v1.post("/downloads/pause-all")
def downloads_pause_all():
    user, err = _require_user()
    if err:
        return err
    from .download_manager import download_manager

    stopped = download_manager.pause_all()
    return jsonify({"ok": True, "paused": stopped})


@api_v1.post("/downloads/start-all")
def downloads_start_all():
    user, err = _require_user()
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    from .download_manager import download_manager

    started = download_manager.start_all(
        api_key=user.api_key or None, force=data.get("force", True) is not False
    )
    return jsonify({"ok": True, "started": started})


@api_v1.post("/downloads/cancel")
def downloads_cancel():
    user, err = _require_user()
    if err:
        return err
    from .download_manager import download_manager

    data = request.get_json(force=True, silent=True) or {}
    ok, msg = download_manager.cancel_task(data.get("modelId"), data.get("versionId"))
    return jsonify({"ok": ok, "message": msg}), (200 if ok else 404)


# --------------------------------------------------------------- library ---

@api_v1.get("/library")
def library():
    user, err = _require_user()
    if err:
        return err
    rows = Download.query.order_by(Download.id.desc()).limit(2000).all()
    # Rows stored before the architecture was captured (or scanned while
    # Civitai was unreachable) would render an "unknown" chip forever: read the
    # safetensors header once and persist it. Capped so a big library does not
    # stall the first response — the rest fills in on later loads.
    from .scanner import infer_base_model

    patched = 0
    for d in rows:
        if d.base_model or patched >= 25:
            continue
        path = (d.get_files() or {}).get("model")
        if not path:
            continue
        guess = infer_base_model(path)
        if guess:
            d.base_model = guess
            patched += 1
    if patched:
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
    return jsonify(
        {
            "items": [
                {
                    "id": d.id,
                    "modelId": d.model_id,
                    "versionId": d.version_id,
                    "name": d.name,
                    "type": d.type,
                    "baseModel": d.base_model or "",
                    "files": d.get_files(),
                }
                for d in rows
            ]
        }
    )


# Latest Civitai version per model id, reused across library views so opening
# the Library does not hammer the API. 10 minutes is short enough that a fresh
# release shows up soon after the user refreshes.
_LIBRARY_UPDATE_TTL = 600
_LIBRARY_UPDATE_CACHE: dict = {}
_LIBRARY_UPDATE_LOCK = threading.Lock()


def _latest_civitai_version(model_id: int, api_key: str | None):
    now = time.time()
    with _LIBRARY_UPDATE_LOCK:
        hit = _LIBRARY_UPDATE_CACHE.get(model_id)
        if hit and now - hit[0] < _LIBRARY_UPDATE_TTL:
            return hit[1]
    from . import api as civitai_api

    try:
        full = civitai_api.get_model(model_id, api_key)
    except Exception as error:
        print(f"Library update check failed for model {model_id}: {error}")
        return None
    versions = full.get("modelVersions") or []
    latest = versions[0] if versions else None
    if not isinstance(latest, dict):
        return None
    info = {
        "id": latest.get("id"),
        "name": latest.get("name") or "",
        "baseModel": latest.get("baseModel") or "",
        "publishedAt": latest.get("publishedAt") or latest.get("createdAt") or "",
    }
    with _LIBRARY_UPDATE_LOCK:
        _LIBRARY_UPDATE_CACHE[model_id] = (now, info)
    return info


@api_v1.post("/library/updates")
def library_updates():
    """Report a newer Civitai version for installed models.

    The Library sends the identified rows it shows; each distinct model id is
    checked once (cached, four at a time) and only models whose current version
    is not the newest one come back.
    """
    user, err = _require_user()
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    items = data.get("items") or []
    wanted: dict[int, list[int]] = {}
    for raw in items if isinstance(items, list) else []:
        try:
            model_id = int(raw.get("modelId") or 0)
            version_id = int(raw.get("versionId") or 0)
        except (TypeError, ValueError, AttributeError):
            continue
        if model_id <= 0 or version_id <= 0:
            continue
        wanted.setdefault(model_id, []).append(version_id)
    model_ids = list(wanted)[:60]
    if not model_ids:
        return jsonify({"updates": {}})

    api_key = user.api_key or None
    with ThreadPoolExecutor(max_workers=4) as pool:
        latest_by_model = dict(zip(model_ids, pool.map(lambda mid: _latest_civitai_version(mid, api_key), model_ids)))

    updates = {}
    for model_id in model_ids:
        latest = latest_by_model.get(model_id)
        latest_id = latest.get("id") if isinstance(latest, dict) else None
        if not latest_id:
            continue
        for version_id in wanted[model_id]:
            if int(latest_id) != version_id:
                updates[f"{model_id}-{version_id}"] = latest
    return jsonify({"updates": updates, "truncated": len(wanted) > len(model_ids)})


@api_v1.put("/library/<int:row_id>/identify")
def library_identify(row_id: int):
    """Adopt a Civitai match for an unidentified row (Update metadata)."""
    user, err = _require_user()
    if err:
        return err
    row = db.session.get(Download, row_id)
    if row is None:
        return jsonify({"error": "not found"}), 404
    data = request.get_json(force=True, silent=True) or {}
    try:
        model_id = int(data.get("modelId") or 0)
        version_id = int(data.get("versionId") or 0)
    except (TypeError, ValueError):
        return jsonify({"error": "modelId and versionId required"}), 400
    if model_id <= 0 or version_id <= 0:
        return jsonify({"error": "modelId and versionId required"}), 400
    from . import api as civitai_api

    try:
        full = civitai_api.get_model(model_id, user.api_key or None)
    except Exception as e:
        return jsonify({"error": f"Civitai lookup failed: {e}"}), 502
    version = next((v for v in full.get("modelVersions", []) if v.get("id") == version_id), None)
    if version is None:
        return jsonify({"error": "version not found on Civitai"}), 400
    row.model_id = model_id
    row.version_id = version_id
    row.name = full.get("name", row.name)
    row.type = full.get("type", row.type)
    row.base_model = version.get("baseModel") or row.base_model
    db.session.commit()
    return jsonify(
        {
            "ok": True,
            "item": {
                "id": row.id,
                "modelId": row.model_id,
                "versionId": row.version_id,
                "name": row.name,
                "type": row.type,
                "baseModel": row.base_model or "",
                "files": row.get_files(),
            },
        }
    )


@api_v1.put("/library/<int:row_id>/cover")
def library_set_cover(row_id: int):
    """Replace the local library's on-disk preview with a selected image."""
    import tempfile
    from urllib.parse import urlparse

    user, err = _require_user()
    if err:
        return err
    row = db.session.get(Download, row_id)
    if row is None:
        return jsonify({"error": "not found"}), 404
    data = request.get_json(force=True, silent=True) or {}
    image_url = data.get("imageUrl")
    if not isinstance(image_url, str) or len(image_url) > 2048:
        return jsonify({"error": "valid imageUrl required"}), 400
    parsed = urlparse(image_url)
    host = (parsed.hostname or "").lower()
    if (
        parsed.scheme != "https"
        or not _civitai_host_ok(host)
        or parsed.username
        or parsed.password
    ):
        return jsonify({"error": "imageUrl must be an HTTPS Civitai image URL"}), 400
    files = row.get_files()
    model_path = files.get("model")
    if not isinstance(model_path, str) or not model_path:
        return jsonify({"error": "model file path is missing"}), 400
    model_path = os.path.realpath(model_path)
    allowed = [
        os.path.realpath(s.value or "")
        for s in Setting.query.all()
        if s.key.startswith("dir_") and (s.value or "").strip()
    ]
    if not any(model_path.startswith(root + os.sep) for root in allowed):
        return jsonify({"error": "model file is outside configured model directories"}), 403
    if not os.path.isfile(model_path):
        return jsonify({"error": "model file not found"}), 404

    image_path = files.get("image")
    image_path = os.path.realpath(image_path) if isinstance(image_path, str) and image_path else ""
    model_dir = os.path.dirname(model_path)
    if image_path and os.path.dirname(image_path) != model_dir:
        return jsonify({"error": "preview image must be beside the model file"}), 400

    import requests

    # Civitai rejects bare fetches (no User-Agent) and some previews need
    # the caller's key — mirror the /proxy/image headers here.
    fetch_headers = {"User-Agent": "SDCodex/1.0 (+https://github.com/LainStable/SDCodex)"}
    authorization = (request.headers.get("Authorization") or "").strip()
    if authorization.lower().startswith("bearer "):
        fetch_headers["Authorization"] = authorization
    elif getattr(user, "api_key", None):
        fetch_headers["Authorization"] = f"Bearer {user.api_key}"

    temporary_path = None
    try:
        response = _civitai_get(image_url, fetch_headers)
        try:
            if response.status_code != 200:
                return jsonify({"error": f"Civitai returned {response.status_code}"}), 502
            if not (response.headers.get("Content-Type") or "").lower().startswith("image/"):
                return jsonify({"error": "Civitai did not return an image"}), 502
            existing_image = bool(image_path and os.path.isfile(image_path))
            if not image_path or not existing_image:
                content_type = response.headers.get("Content-Type", "").lower()
                ext = ".png" if "png" in content_type else ".jpg" if "jpeg" in content_type else ".webp"
                image_path = os.path.join(model_dir, os.path.splitext(os.path.basename(model_path))[0] + ext)
            fd, temporary_path = tempfile.mkstemp(prefix=".sdcodex-preview-", dir=model_dir)
            total = 0
            with os.fdopen(fd, "wb") as output:
                for chunk in response.iter_content(chunk_size=64 * 1024):
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > 20 * 1024 * 1024:
                        return jsonify({"error": "preview image exceeds 20 MB"}), 413
                    output.write(chunk)
        finally:
            response.close()
        os.replace(temporary_path, image_path)
        temporary_path = None
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except requests.RequestException as exc:
        return jsonify({"error": f"image download failed: {exc}"}), 502
    except OSError as exc:
        return jsonify({"error": f"could not save preview image: {exc}"}), 500
    finally:
        if temporary_path and os.path.exists(temporary_path):
            os.remove(temporary_path)

    files.pop("imageUrl", None)
    files["image"] = image_path
    row.set_files(files)
    db.session.commit()
    return jsonify({"ok": True, "image": image_path})


@api_v1.get("/files")
def serve_file():
    """Serve a model/preview file from disk (mirrors OldCode /files/<path>).

    Authed only, and confined to configured model directories.
    Usage: /api/files?path=/models/lora/foo.preview.png
    """
    from flask import send_file

    user, err = _require_user()
    if err:
        return err
    import os

    raw = request.args.get("path", "")
    if not raw:
        return jsonify({"error": "path required"}), 400
    real = os.path.realpath(raw if os.path.isabs(raw) else os.path.join("/", raw))
    allowed = [
        os.path.realpath(v)
        for v in (s.value or "" for s in Setting.query.all() if s.key.startswith("dir_"))
        if v
    ]
    if not any(real == root or real.startswith(root + os.sep) for root in allowed):
        return jsonify({"error": "outside model directories"}), 403
    if not os.path.isfile(real):
        return jsonify({"error": "not found"}), 404
    inline = {
        ".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp",
        ".mp4", ".webm", ".mov", ".mkv",
        ".safetensors", ".ckpt", ".pt", ".bin", ".json", ".txt",
    }
    # Anything else is downloaded rather than rendered: a stray .html file in
    # a model folder must not become same-origin script.
    return send_file(real, as_attachment=os.path.splitext(real)[1].lower() not in inline)


@api_v1.get("/proxy/image")
def proxy_image():
    """Proxy a Civitai image URL for download.

    Used by the frontend when browser CORS prevents direct fetch. Authed only
    and restricted to Civitai hosts so it cannot be used as an SSRF relay.
    """
    user, err = _require_user()
    if err:
        return err

    image_url = request.args.get("url")
    if not isinstance(image_url, str) or not image_url or len(image_url) > 2048:
        return jsonify({"error": "valid url required"}), 400
    if not _civitai_host_ok(urlparse(image_url).hostname):
        return jsonify({"error": "only Civitai image URLs are supported"}), 400

    headers = {"User-Agent": "SDCodex/1.0 (+https://github.com/LainStable/SDCodex)"}
    # Never forward a caller-supplied token to an arbitrary upstream; the
    # server-held account key is the only credential this proxy needs.
    if user.api_key:
        headers["Authorization"] = f"Bearer {user.api_key}"

    try:
        upstream = _civitai_get(image_url, headers)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except requests.RequestException as exc:
        return jsonify({"error": f"download failed: {exc}"}), 502

    try:
        if upstream.status_code != 200:
            status_code = upstream.status_code
            upstream.close()
            return jsonify({"error": f"upstream returned {status_code}"}), min(599, max(400, status_code))
        content_type = (upstream.headers.get("Content-Type") or "").lower()
        if not content_type.startswith("image/"):
            upstream.close()
            return jsonify({"error": "upstream did not return an image"}), 502
        declared = upstream.headers.get("Content-Length")
        if declared:
            try:
                if int(declared) > _MAX_IMAGE_BYTES:
                    upstream.close()
                    return jsonify({"error": "image exceeds 25 MB"}), 413
            except ValueError:
                declared = None
    except Exception:
        upstream.close()
        raise

    def _generate():
        total = 0
        try:
            for chunk in upstream.iter_content(chunk_size=64 * 1024):
                if not chunk:
                    continue
                total += len(chunk)
                if total > _MAX_IMAGE_BYTES:
                    break
                yield chunk
        finally:
            upstream.close()

    response = Response(_generate(), status=200, content_type=content_type)
    if declared:
        response.headers["Content-Length"] = declared
    response.headers["Cache-Control"] = "private, max-age=3600"
    return response


@api_v1.post("/scan")
def scan():
    user, err = _require_user()
    if err:
        return err
    from .download_manager import download_manager

    data = request.get_json(force=True, silent=True) or {}
    types = data.get("types")
    if types is not None and (not isinstance(types, list) or not all(isinstance(t, str) for t in types)):
        return jsonify({"error": "types must be a string list"}), 400
    task = download_manager.add_task(
        api_key=user.api_key or None, task_type="scan", model_types=types
    )
    return jsonify({"ok": True, "status": task.get("status")})


# ------------------------------------------------------------------ oidc ---

def _oidc_json(c: OidcConfig, include_secret: bool = False) -> dict:
    out = {
        "id": c.id,
        "name": c.name,
        "enabled": bool(c.enabled),
        "issuerUrl": c.issuer_url,
        "clientId": c.client_id,
        "redirectUri": c.redirect_uri or "",
        "scopes": c.scopes or "openid profile email",
        "usernameClaim": c.username_claim or "preferred_username",
        "emailClaim": c.email_claim or "email",
        "displayNameClaim": c.display_name_claim or "name",
        "adminClaim": c.admin_claim or "",
        "adminValue": c.admin_value or "",
    }
    if include_secret:
        out["clientSecretSet"] = bool(c.client_secret)
    return out


@api_v1.get("/oidc")
def oidc_list():
    user, err = _require_user()
    if err:
        return err
    if not user.is_admin:
        return jsonify({"error": "admin only"}), 403
    return jsonify({"items": [_oidc_json(c) for c in OidcConfig.query.all()]})


@api_v1.post("/oidc")
def oidc_create():
    user, err = _require_user()
    if err:
        return err
    if not user.is_admin:
        return jsonify({"error": "admin only"}), 403
    data = request.get_json(force=True, silent=True) or {}
    if not (data.get("name") or "").strip() or not (data.get("issuerUrl") or "").strip():
        return jsonify({"error": "name and issuerUrl required"}), 400
    from . import oidc as oidc_mod  # noqa: F401 (ensures helpers load)

    row = OidcConfig(
        name=data["name"].strip(),
        enabled=bool(data.get("enabled", True)),
        issuer_url=data["issuerUrl"].strip().rstrip("/"),
        client_id=(data.get("clientId") or "").strip(),
        client_secret=data.get("clientSecret") or "",
        redirect_uri=(data.get("redirectUri") or "").strip(),
        scopes=data.get("scopes") or "openid profile email",
        username_claim=data.get("usernameClaim") or "preferred_username",
        email_claim=data.get("emailClaim") or "email",
        display_name_claim=data.get("displayNameClaim") or "name",
        admin_claim=data.get("adminClaim") or "",
        admin_value=data.get("adminValue") or "",
    )
    db.session.add(row)
    db.session.commit()
    return jsonify({"ok": True, "item": _oidc_json(row)})


@api_v1.delete("/oidc/<int:config_id>")
def oidc_delete(config_id: int):
    user, err = _require_user()
    if err:
        return err
    if not user.is_admin:
        return jsonify({"error": "admin only"}), 403
    row = db.session.get(OidcConfig, config_id)
    if row is None:
        return jsonify({"error": "not found"}), 404
    db.session.delete(row)
    db.session.commit()
    return jsonify({"ok": True})


@api_v1.post("/oidc/<int:config_id>/test")
def oidc_test(config_id: int):
    user, err = _require_user()
    if err:
        return err
    if not user.is_admin:
        return jsonify({"error": "admin only"}), 403
    row = db.session.get(OidcConfig, config_id)
    if row is None:
        return jsonify({"error": "not found"}), 404
    from . import oidc as oidc_mod

    try:
        result = oidc_mod.test_oidc_config(row)
        return jsonify({"ok": True, "result": result})
    except Exception as e:  # keep the failure legible, never a 500
        return jsonify({"ok": False, "error": str(e)}), 502


@api_v1.get("/oidc/public")
def oidc_public():
    """Public: enabled providers (names only) so the login gate can offer SSO."""
    from urllib.parse import urlparse

    from . import oidc as oidc_mod

    items = []
    for c in oidc_mod.enabled_configs():
        try:
            host = urlparse(c.issuer_url).hostname or ""
        except Exception:
            host = ""
        items.append({"id": c.id, "name": c.name, "host": host})
    return jsonify({"items": items})


@api_v1.get("/oidc/<int:config_id>/login-url")
def oidc_login_url(config_id: int):
    """Public: start SSO from the login gate. Returns the provider URL."""
    from . import oidc as oidc_mod

    row = db.session.get(OidcConfig, config_id)
    if row is None or not row.enabled:
        return jsonify({"error": "provider unavailable"}), 404
    result = oidc_mod.build_authorization_url(row, redirect_url="/")
    if result.get("error"):
        return jsonify({"error": result["error"]}), 502
    return jsonify({"ok": True, "url": result["url"]})


@api_v1.post("/auth/oidc/callback")
def oidc_callback():
    """Public: complete SSO after the provider redirects back."""
    from . import oidc as oidc_mod

    data = request.get_json(force=True, silent=True) or {}
    if not data.get("code") or not data.get("state"):
        return jsonify({"error": "code and state required"}), 400
    result = oidc_mod.handle_callback(data["code"], data["state"])
    if not result.get("success"):
        return jsonify({"error": result.get("error", "sign-in failed")}), 401
    user = result["user"]
    token = auth.create_session(user.id, f"oidc:{user.auth_provider}")
    resp = make_response(jsonify({"ok": True, "user": _user_json(user)}))
    auth.set_session_cookie(resp, token)
    return resp


# ------------------------------------------------- updates + plugins ---

def _admin_or_401():
    user = auth.current_user()
    if user is None:
        return None, (jsonify({"error": "unauthorized"}), 401)
    if not user.is_admin:
        return None, (jsonify({"error": "admin only"}), 403)
    return user, None


def _mode_mismatch(rebuilder_mod):
    status = rebuilder_mod.install_mode_status()
    if status["matches_runtime"]:
        return None
    return (
        jsonify({
            "error": (
                f"Selected {status['mode']} mode does not match the running "
                f"{status['runtime_mode']} app. Restart externally in the selected mode first."
            )
        }),
        409,
    )


@api_v1.get("/system/install-mode")
def system_install_mode_get():
    # Read-only and needed by the pre-auth login gate (the badge switches
    # between local/docker there); the admin-only write stays protected below.
    from . import rebuilder as rebuilder_mod

    return jsonify(rebuilder_mod.install_mode_status())


@api_v1.put("/system/install-mode")
def system_install_mode_save():
    _, err = _admin_or_401()
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    mode = data.get("mode")
    if not isinstance(mode, str) or mode not in {"docker", "local"}:
        return jsonify({"error": "mode must be 'docker' or 'local'"}), 400
    row = db.session.get(Setting, "install_mode")
    if row is None:
        row = Setting(key="install_mode")
        db.session.add(row)
    row.value = mode
    db.session.commit()
    from . import rebuilder as rebuilder_mod

    return jsonify(rebuilder_mod.install_mode_status())


@api_v1.get("/updates/check")
def updates_check():
    _, err = _admin_or_401()
    if err:
        return err
    from . import rebuilder as rebuilder_mod
    from . import updater as updater_mod

    core = updater_mod.check_core()
    plugin_updates = updater_mod.check_plugin_updates()
    rebuild_required = rebuilder_mod.needs_rebuild()
    return jsonify(
        {
            "core": core,
            "plugins": plugin_updates,
            "rebuild_required": rebuild_required,
            "rebuild": rebuilder_mod.rebuild_capability(),
            "install_mode": rebuilder_mod.install_mode_status(),
            "total": (1 if core.get("has_update") else 0)
            + len(plugin_updates),
        }
    )


@api_v1.post("/updates/core")
def updates_core_apply():
    _, err = _admin_or_401()
    if err:
        return err
    from . import updater as updater_mod
    from . import rebuilder as rebuilder_mod

    capability = rebuilder_mod.rebuild_capability()
    if not capability["can_rebuild"]:
        if capability["mode"] == "mismatch":
            return jsonify({
                "ok": False,
                "message": "Configured install mode does not match the running app. Restart it in the selected mode before updating.",
            }), 409
        return jsonify({
            "ok": False,
            "message": "Core self-update is unavailable in this Docker setup; update it from the host.",
        }), 409

    ok, msg = updater_mod.update_core()
    return jsonify({"ok": ok, "message": msg}), (200 if ok else 409)


@api_v1.post("/system/rebuild")
def system_rebuild():
    """Pull-triggered rebuild: image build + container replace (Docker) or
    backend restart (Local). Runs in the background; the frontend polls
    health and reloads."""
    _, err = _admin_or_401()
    if err:
        return err
    from . import rebuilder as rebuilder_mod

    ok, msg = rebuilder_mod.start_rebuild()
    return jsonify({"ok": ok, "message": msg}), (200 if ok else 409)


@api_v1.get("/system/rebuild/log")
def system_rebuild_log():
    """Tail core update, image-build, and restart progress for the UI."""
    _, err = _admin_or_401()
    if err:
        return err
    from . import rebuilder as rebuilder_mod

    try:
        with open(os.path.join(rebuilder_mod.root_dir(), ".rebuild.log"), encoding="utf-8") as f:
            lines = f.readlines()
    except FileNotFoundError:
        lines = []
    return jsonify({"lines": [l.rstrip("\n") for l in lines[-120:]]})


@api_v1.get("/plugins")
def plugins_list():
    user, err = _require_user()
    if err:
        return err
    from . import updater as updater_mod

    installed = updater_mod.list_installed()
    # Never wait on `git ls-remote` here: plugin detection used to sit behind a
    # serial network walk and the whole radial menu vanished for minutes after
    # a restart. Serve the manifests now, probe remotes in the background, and
    # let the UI retry until `updates_checked` is true.
    update_list, checked = updater_mod.cached_plugin_updates()
    updates = {p["id"]: p for p in update_list}
    for p in installed:
        p["has_update"] = p["id"] in updates
        if p["id"] in updates:
            p["remote_sha"] = updates[p["id"]].get("remote_sha", "")
    return jsonify({"installed": installed, "updates_checked": checked})


@api_v1.get("/plugin-tasks")
def plugin_tasks():
    """Running background tasks reported by installed plugins.

    A plugin opts in with a ``task_status`` manifest entry whose ``path``
    points at an in-process API route returning a normalized payload::

        {"active": true, "state": "running", "current": 3, "total": 12,
         "label": "AI Renamer", "message": "Analyzing 3 / 12"}

    The floating task notification polls this endpoint, so plugin work stays
    visible while the user browses elsewhere in the app.
    """
    _, err = _require_user()
    if err:
        return err
    from . import assistant

    return jsonify({"tasks": assistant.plugin_tasks(request.headers.get("Cookie", ""))})


# ------------------------------------------------------------ assistant ---

@api_v1.get("/assistant/status")
def assistant_status():
    user, err = _require_user()
    if err:
        return err
    from . import assistant

    settings = assistant.assistant_settings()
    return jsonify({**settings, "isAdmin": bool(user.is_admin)})


@api_v1.post("/assistant/settings")
def assistant_settings_save():
    user, err = _admin_or_401()
    if err:
        return err
    from . import assistant

    data = request.get_json(force=True, silent=True) or {}
    settings = assistant.save_assistant_settings(
        data, clear_key=bool(data.get("clearApiKey"))
    )
    return jsonify(settings)


@api_v1.post("/assistant/test")
def assistant_test():
    user, err = _admin_or_401()
    if err:
        return err
    from . import assistant

    data = request.get_json(force=True, silent=True) or {}
    if data:
        # Allow testing values before saving them.
        assistant.save_assistant_settings(data)
    return jsonify(assistant.test_connection())


@api_v1.post("/assistant/chat")
def assistant_chat():
    _, err = _require_user()
    if err:
        return err
    from . import assistant

    data = request.get_json(force=True, silent=True) or {}
    messages = data.get("messages")
    if not isinstance(messages, list):
        return jsonify({"ok": False, "error": "Send a 'messages' list."}), 400
    approved = data.get("approved") if isinstance(data.get("approved"), dict) else None
    result = assistant.chat(
        messages, cookie=request.headers.get("Cookie", ""), approved=approved
    )
    return jsonify(result), (200 if result.get("ok") else 400)


@api_v1.get("/assistant/tools")
def assistant_tools():
    _, err = _require_user()
    if err:
        return err
    from . import assistant

    return jsonify({"tools": assistant.tool_schemas()})


# ------------------------------------------------------------------ MCP ---

@api_v1.get("/mcp/settings")
def mcp_settings_get():
    user, err = _require_user()
    if err:
        return err
    from . import assistant

    return jsonify({**assistant.mcp_settings(), "isAdmin": bool(user.is_admin)})


@api_v1.post("/mcp/settings")
def mcp_settings_save():
    _, err = _admin_or_401()
    if err:
        return err
    from . import assistant

    data = request.get_json(force=True, silent=True) or {}
    return jsonify(assistant.save_mcp_settings(data))


@api_v1.route("/mcp", methods=["POST", "GET", "DELETE"])
def mcp_endpoint():
    """MCP server for external agents (Settings → System → MCP server).

    Authenticated with the instance token rather than the UI session, so an
    agent process can connect without a browser login.
    """
    from . import assistant, mcp

    header = request.headers.get("Authorization", "")
    token = header[7:].strip() if header.lower().startswith("bearer ") else ""
    settings = assistant.mcp_settings()
    if not settings["enabled"]:
        return jsonify({"error": "The MCP server is disabled. Enable it in Settings → System."}), 403
    if not assistant.mcp_token_valid(token):
        return jsonify({"error": "unauthorized"}), 401

    if request.method == "GET":
        return jsonify(
            {
                "transport": "streamable-http (JSON-RPC over POST)",
                "protocolVersion": mcp.PROTOCOL_VERSION,
                "hint": "POST JSON-RPC messages to this endpoint with the bearer token.",
            }
        )
    if request.method == "DELETE":
        # Session teardown is a no-op: the server keeps no per-session state.
        return ("", 204)

    payload, status, is_json = mcp.handle_body(
        request.get_data(), cookie=request.headers.get("Cookie", "")
    )
    if not is_json:
        return ("", status)
    response = make_response(payload, status)
    response.headers["Content-Type"] = "application/json"
    return response


@api_v1.get("/plugins/store")
def plugins_store():
    user, err = _require_user()
    if err:
        return err
    from . import updater as updater_mod

    catalog = updater_mod.fetch_store_catalog()
    installed_ids = {p["id"] for p in updater_mod.list_installed()}
    items = catalog.get("plugins", [])
    for p in items:
        p["installed"] = p.get("id") in installed_ids
    return jsonify({"core": catalog.get("core"), "plugins": items})


@api_v1.post("/plugins/install")
def plugins_install():
    _, err = _admin_or_401()
    if err:
        return err
    from . import updater as updater_mod
    from . import rebuilder as rebuilder_mod

    data = request.get_json(force=True, silent=True) or {}
    repo_url = (data.get("repo_url") or "").strip()
    if not repo_url:
        return jsonify({"error": "repo_url required"}), 400
    mode_error = _mode_mismatch(rebuilder_mod)
    if mode_error:
        return mode_error

    install_mode = rebuilder_mod.configured_install_mode()
    ok, result = updater_mod.install_plugin(
        repo_url,
        data.get("volumes") or {},
        install_mode=install_mode,
    )
    if not ok:
        return jsonify({"error": result}), 502
    # Record the repo + wire volumes/env.
    short, canonical = updater_mod.normalize_github_url(repo_url)
    repo = PluginRepo.query.filter_by(repo_url=canonical).first()
    if repo is None:
        repo = PluginRepo(
            repo_url=canonical,
            name=result.get("name", short),
            description="Installed via Plugin Hub",
        )
        db.session.add(repo)
        db.session.commit()
    if install_mode == "docker":
        updater_mod.apply_volume_config(
            {"id": result["id"], "volumes": result.get("volumes", [])},
            data.get("volumes") or {},
        )
    return jsonify({"ok": True, "plugin": result})


@api_v1.post("/plugins/<plugin_id>/update")
def plugins_update(plugin_id: str):
    _, err = _admin_or_401()
    if err:
        return err
    from . import updater as updater_mod
    from . import rebuilder as rebuilder_mod

    mode_error = _mode_mismatch(rebuilder_mod)
    if mode_error:
        return mode_error

    ok, msg = updater_mod.update_plugin(plugin_id)
    return jsonify({"ok": ok, "message": msg}), (200 if ok else 409)


@api_v1.delete("/plugins/<plugin_id>")
def plugins_uninstall(plugin_id: str):
    _, err = _admin_or_401()
    if err:
        return err
    from . import updater as updater_mod
    from . import rebuilder as rebuilder_mod

    mode_error = _mode_mismatch(rebuilder_mod)
    if mode_error:
        return mode_error

    ok, msg = updater_mod.uninstall_plugin(
        plugin_id,
        install_mode=rebuilder_mod.configured_install_mode(),
    )
    if ok:
        row = PluginRepo.query.filter(
            (PluginRepo.name == plugin_id) | (PluginRepo.repo_url.contains(plugin_id))
        ).first()
        if row:
            db.session.delete(row)
            db.session.commit()
    return jsonify({"ok": ok, "message": msg}), (200 if ok else 404)


@api_v1.get("/plugins/<plugin_id>/volumes")
def plugin_volumes(plugin_id: str):
    """Volume contract for an installed plugin (manifest + current .env values)."""
    _, err = _require_user()
    if err:
        return err
    from . import updater as updater_mod
    from . import rebuilder as rebuilder_mod

    base = updater_mod.plugin_path(plugin_id)
    if not base:
        return jsonify({"error": "Not installed."}), 404
    mode_error = _mode_mismatch(rebuilder_mod)
    if mode_error:
        return mode_error
    if rebuilder_mod.configured_install_mode() != "docker":
        return jsonify({"id": plugin_id, "volumes": []})

    mf = updater_mod.read_manifest(base) or {}
    env_vals: dict = {}
    env_path = os.path.join(updater_mod.root_dir(), ".env")
    if os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if s and not s.startswith("#") and "=" in s:
                    k, v = s.split("=", 1)
                    env_vals[k.strip()] = v.strip()
    volumes = []
    for v in mf.get("volumes", []):
        if not isinstance(v, dict) or not v.get("env_var"):
            continue
        vv = dict(v)
        vv["value"] = env_vals.get(vv["env_var"], vv.get("host_path", ""))
        volumes.append(vv)
    return jsonify({"id": plugin_id, "volumes": volumes})


@api_v1.post("/plugins/<plugin_id>/volumes")
def plugin_volumes_save(plugin_id: str):
    """Save host paths for a plugin's volumes (.env + compose override)."""
    _, err = _admin_or_401()
    if err:
        return err
    from . import updater as updater_mod
    from . import rebuilder as rebuilder_mod

    base = updater_mod.plugin_path(plugin_id)
    if not base:
        return jsonify({"error": "Not installed."}), 404
    mode_error = _mode_mismatch(rebuilder_mod)
    if mode_error:
        return mode_error
    if rebuilder_mod.configured_install_mode() != "docker":
        return jsonify({"error": "Plugin volume mounts can only be configured in Docker mode."}), 409
    mf = updater_mod.read_manifest(base) or {"id": plugin_id}
    data = request.get_json(force=True, silent=True) or {}
    values = data.get("volumes") or {}
    if not isinstance(values, dict):
        return jsonify({"error": "volumes must be an object"}), 400
    resolved = {}
    for v in mf.get("volumes", []):
        if not isinstance(v, dict) or not v.get("env_var"):
            continue
        try:
            val = _clean_env_value(values.get(v["env_var"]) or v.get("host_path") or "")
        except ValueError as exc:
            return jsonify({"error": f"{v['env_var']}: {exc}"}), 400
        if val:
            resolved[v["env_var"]] = val
    updater_mod.apply_volume_config({"id": mf.get("id", plugin_id), "volumes": mf.get("volumes", [])}, resolved)
    rebuilder_mod.mark_rebuild(f"volumes {mf.get('id', plugin_id)}")
    return jsonify({"ok": True, "volumes": resolved})


@api_v1.post("/plugins/github-token")
def plugins_github_token():
    """Save the GitHub token (private plugin repos) to DB + .env."""
    _, err = _admin_or_401()
    if err:
        return err
    from . import updater as updater_mod

    data = request.get_json(force=True, silent=True) or {}
    token = (data.get("token") or "").strip()
    if token and not re.fullmatch(r"[A-Za-z0-9_-]{1,255}", token):
        return jsonify({"error": "GitHub token contains invalid characters"}), 400
    try:
        row = db.session.get(Setting, "github_token")
        if row is None:
            row = Setting(key="github_token", value=token)
            db.session.add(row)
        else:
            row.value = token
        db.session.commit()
    except Exception as e:
        return jsonify({"error": str(e)[:200]}), 500
    updater_mod.update_env_file({"GITHUB_TOKEN": token})
    return jsonify({"ok": True, "saved": bool(token)})


@api_v1.get("/plugins/github-token")
def plugins_github_token_status():
    """Whether a GitHub token is saved (value never leaves the server)."""
    _, err = _require_user()
    if err:
        return err
    from . import updater as updater_mod

    return jsonify({"saved": bool(updater_mod._github_token())})


# ------------------------------------------------- plugin pages ----------
# Installed plugins ship Stitch-styled static pages (pages/*.html). The React
# shell embeds them (sidebar nav + settings tabs) — no OldCode templates.

_PAGE_RE = __import__("re").compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")

_MISSING_PAGE = """<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>body{{background:#0f131c;color:#c7c4d7;font:12px monospace;padding:32px}}h1{{color:#fff;font-size:15px}}</style>
</head><body><h1>{title}</h1><p>{detail}</p>
<p>Ship <code>pages/{name}.html</code> in the plugin repo to fill this slot.</p></body></html>"""


# --- plugin button kit ---------------------------------------------------
# Plugin pages cannot import the React components, so the core injects the
# same button shapes it renders itself (app/src/components/chrome.tsx:
# PrimaryButton / GhostButton / DangerButton plus the filter pills). Plugin
# pages opt in with `sd-btn` + a variant class; colours resolve through the
# theme variables the bridge below installs, so addons follow the active theme.
_PLUGIN_UI_CSS = """<style id="sdcodex-plugin-ui">
.sd-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 6px 12px; border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px; background-color: transparent; background-image: none;
  color: rgb(var(--c-ink-muted, 199 196 215));
  font-family: Inter, system-ui, sans-serif; font-size: 12px; font-weight: 500;
  line-height: 16px; white-space: nowrap; text-decoration: none;
  cursor: pointer; box-shadow: none;
  transition: background-color .15s ease, border-color .15s ease,
              color .15s ease, opacity .15s ease;
}
.sd-btn:hover:not(:disabled):not([aria-disabled="true"]) {
  background-color: rgba(255, 255, 255, 0.05);
  color: rgb(var(--c-ink, 223 226 239));
}
.sd-btn:focus-visible {
  outline: none; border-color: rgb(var(--c-primary, 99 102 241));
  box-shadow: 0 0 0 2px rgb(var(--c-primary, 99 102 241) / 0.25);
}
.sd-btn:disabled, .sd-btn[aria-disabled="true"] { opacity: 0.4; cursor: not-allowed; }
.sd-btn .material-symbols-outlined { font-size: 16px; }

.sd-btn-primary {
  border-color: rgb(var(--c-primary, 99 102 241) / 0.5);
  background-color: rgb(var(--c-primary, 99 102 241) / 0.2);
  color: rgb(var(--c-ink, 223 226 239)); font-weight: 600;
}
.sd-btn-primary:hover:not(:disabled):not([aria-disabled="true"]) {
  border-color: rgb(var(--c-primary, 99 102 241) / 0.65);
  background-color: rgb(var(--c-primary, 99 102 241) / 0.3);
  color: rgb(var(--c-ink, 223 226 239));
}

.sd-btn-danger {
  border-color: rgb(239 68 68 / 0.4); color: #f87171;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 11px; font-weight: 500;
}
.sd-btn-danger:hover:not(:disabled):not([aria-disabled="true"]) {
  border-color: rgb(239 68 68 / 0.55);
  background-color: rgb(239 68 68 / 0.1); color: #fca5a5;
}

.sd-btn-sm {
  padding: 4px 8px; font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 10px; font-weight: 600; letter-spacing: 0.04em;
}

/* Filter / segmented pill — core FilterPills: inactive white/5, active primary/20. */
.sd-btn-pill {
  padding: 2px 8px; border-color: rgba(255, 255, 255, 0.1);
  background-color: rgba(255, 255, 255, 0.05);
  color: rgb(var(--c-ink-muted, 199 196 215));
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 10px; line-height: 1.5; font-weight: 600; letter-spacing: 0.06em;
  text-transform: uppercase;
}
.sd-btn-pill:hover:not(:disabled):not([aria-disabled="true"]) {
  border-color: rgba(255, 255, 255, 0.2);
  background-color: rgba(255, 255, 255, 0.08);
}
.sd-btn-pill[aria-pressed="true"], .sd-btn-pill.is-active {
  border-color: rgb(var(--c-primary, 99 102 241) / 0.5);
  background-color: rgb(var(--c-primary, 99 102 241) / 0.2);
  color: rgb(var(--c-ink, 223 226 239));
}

/* Pressed toggle (segmented mode switches, format pickers). */
.sd-btn[aria-pressed="true"], .sd-btn.is-active {
  border-color: rgb(var(--c-primary, 99 102 241) / 0.5);
  background-color: rgb(var(--c-primary, 99 102 241) / 0.2);
  color: rgb(var(--c-ink, 223 226 239)); font-weight: 600;
}

/* Icon-only action — square ghost that grows a border on hover. */
.sd-btn-icon { width: 28px; height: 28px; padding: 0; border-color: transparent; }
.sd-btn-icon:hover:not(:disabled):not([aria-disabled="true"]) {
  border-color: rgba(255, 255, 255, 0.15);
  background-color: rgba(255, 255, 255, 0.05);
}
.sd-btn-icon .material-symbols-outlined { font-size: 18px; }
</style>"""


# --- plugin theme bridge -------------------------------------------------
# Plugin pages are standalone documents (their own <head>, Tailwind Play CDN,
# hardcoded Stitch palette). They cannot inherit the core's CSS variables, so
# the core injects this bridge before </head>: it paints the page from the
# palette the app mirrors into localStorage (`sdcodex.theme.payload.v1`) and
# repaints on the `sdcodex:theme` message the plugin iframe receives.
_THEME_BRIDGE = """<script id="sdcodex-theme-bridge">
(function () {
  var KEY = 'sdcodex.theme.payload.v1';
  // Plugin pages name their Tailwind colour tokens after the Stitch design
  // system; order matters (a prefix must come before its own extensions).
  var TOKENS = [
    ['surface', '--c-bg'],
    ['surface-container', '--c-obsidian'],
    ['surface-container-low', '--c-bg-low'],
    ['surface-container-lowest', '--c-bg-lowest'],
    ['surface-container-high', '--c-bg-high'],
    ['surface-container-highest', '--c-bg-highest'],
    ['slate-surface', '--c-bg-high'],
    ['background', '--c-bg'],
    ['primary', '--c-primary'],
    ['secondary', '--c-secondary'],
    ['tertiary', '--c-tertiary'],
    ['on-surface', '--c-ink'],
    ['on-surface-variant', '--c-ink-muted'],
    ['outline', '--c-ink-faint'],
    ['outline-variant', '--c-bg-highest'],
    ['badge-checkpoint', '--c-primary'],
    ['badge-sdxl', '--c-secondary'],
    ['badge-lora', '--c-tertiary'],
    ['badge-flux', '--c-secondary']
  ];
  var PROPS = ['bg', 'text', 'border', 'from', 'via', 'to', 'ring', 'fill',
               'stroke', 'divide', 'placeholder', 'shadow'];
  var PROP_CSS = {
    bg: 'background-color', text: 'color', border: 'border-color',
    from: '--tw-gradient-from', via: '--tw-gradient-via', to: '--tw-gradient-to',
    ring: '--tw-ring-color', fill: 'fill', stroke: 'stroke',
    divide: 'border-color', placeholder: 'color', shadow: '--tw-shadow-color'
  };
  // Opacity variants actually used by this page, scanned server-side:
  // [token, prop, "20", state]. Tailwind's own `/20` utility keeps the alpha,
  // so the bridge must re-tint with the same alpha instead of painting solid.
  var ALPHA = __SD_TOKEN_ALPHA__;
  function rules() {
    var out = [];
    TOKENS.forEach(function (pair) {
      var token = pair[0], v = pair[1];
      PROPS.forEach(function (prop) {
        // Word-scoped exact match: e.g. "bg-surface-container-low"
        out.push('[class~="' + prop + '-' + token + '"]{' +
                 PROP_CSS[prop] + ':rgb(var(' + v + '))!important}');
        // Pseudo-class solid variants: hover:bg-primary, focus:border-primary
        out.push('[class*="hover\\:' + prop + '-' + token + '"]:hover{' +
                 PROP_CSS[prop] + ':rgb(var(' + v + '))!important}');
        out.push('[class*="focus\\:' + prop + '-' + token + '"]:focus{' +
                 PROP_CSS[prop] + ':rgb(var(' + v + '))!important}');
      });
    });
    ALPHA.forEach(function (entry) {
      var token = entry[0], prop = entry[1], frac = entry[2], state = entry[3];
      var v = null;
      TOKENS.forEach(function (pair) { if (pair[0] === token) v = pair[1]; });
      if (!v || !PROP_CSS[prop]) return;
      var alpha = Math.min(100, Math.max(0, Number(frac))) / 100;
      var cls = prop + '-' + token + '/' + frac;
      var value = PROP_CSS[prop] + ':rgb(var(' + v + ') / ' + alpha + ')!important';
      if (!state) {
        out.push('[class~="' + cls + '"]{' + value + '}');
      } else {
        out.push('[class*="' + state + '\\:' + cls + '"]:' + state + '{' + value + '}');
      }
    });
    // Baseline styling for inputs, selects, textareas matching Screenshot 3
    out.push('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), select, textarea {' +
             'background-color: rgb(var(--c-bg-lowest)) !important;' +
             'border-color: rgba(255, 255, 255, 0.1) !important;' +
             'color: rgb(var(--c-ink)) !important;' +
             '}');
    out.push('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):focus, select:focus, textarea:focus {' +
             'border-color: rgb(var(--c-primary)) !important;' +
             'outline: none !important;' +
             '}');
    // Checkbox and radio buttons: neutral borders, subtle styling
    out.push('input[type="checkbox"], input[type="radio"] {' +
             'border-color: rgba(255, 255, 255, 0.2) !important;' +
             'background-color: rgba(255, 255, 255, 0.05) !important;' +
             '}');
    // GhostButton style matching Screenshot 1 and Settings model path buttons
    out.push('button.btn-secondary, .btn-ghost, button[class*="border-outline-variant"], .warning-actions .btn-secondary, #info-panel .btn, #info-panel button, #info-panel .caption-this-btn {' +
             'border-color: rgba(255, 255, 255, 0.15) !important;' +
             'color: rgb(var(--c-ink-muted)) !important;' +
             'background-color: transparent !important;' +
             'border-radius: 4px !important;' +
             '}');
    out.push('button.btn-secondary:hover:not(:disabled), .btn-ghost:hover:not(:disabled), button[class*="border-outline-variant"]:hover:not(:disabled), .warning-actions .btn-secondary:hover:not(:disabled), #info-panel .btn:hover:not(:disabled), #info-panel button:hover:not(:disabled), #info-panel .caption-this-btn:hover:not(:disabled) {' +
             'background-color: rgba(255, 255, 255, 0.08) !important;' +
             'border-color: rgba(255, 255, 255, 0.25) !important;' +
             'color: #ffffff !important;' +
             '}');
    out.push('button.btn-primary, .btn-primary, .warning-actions .btn-primary {' +
             'border-color: rgb(var(--c-primary) / 0.5) !important;' +
             'background-color: rgb(var(--c-primary) / 0.2) !important;' +
             'color: rgb(var(--c-ink)) !important;' +
             'border-radius: 4px !important;' +
             '}');
    out.push('button.btn-primary:hover:not(:disabled), .btn-primary:hover:not(:disabled), .warning-actions .btn-primary:hover:not(:disabled) {' +
             'background-color: rgb(var(--c-primary) / 0.3) !important;' +
             '}');
    out.push('#info-panel, aside.info-panel, #gallery-wrapper.viewer-open #info-panel {' +
             'background-color: rgb(var(--c-obsidian)) !important;' +
             'border-color: rgba(255, 255, 255, 0.1) !important;' +
             'color: rgb(var(--c-ink)) !important;' +
             'border-radius: 12px !important;' +
             '}');
    // Hardcoded near-black inputs / code panes in the shipped pages.
    out.push('[class*="bg-[#070a10]"]{background-color:rgb(var(--c-bg-lowest))!important}');
    out.push('[class*="bg-[#0a0e17]"]{background-color:rgb(var(--c-bg-lowest))!important}');
    // White headings become theme ink so light themes stay readable.
    out.push('[class*="text-white"]{color:rgb(var(--c-ink))!important}');
    out.push('.font-display{font-family:var(--sd-font-display)!important}');
    out.push('.font-body{font-family:var(--sd-font-body)!important}');
    return out.join('\\n');
  }
  function apply(theme) {
    if (!theme || !theme.vars) return;
    var root = document.documentElement;
    Object.keys(theme.vars).forEach(function (k) {
      root.style.setProperty(k, theme.vars[k]);
      if (k.indexOf('--c-') === 0) {
        root.style.setProperty('--' + k.slice(4), 'rgb(' + theme.vars[k] + ')');
      }
    });
    // Standard variables for non-Tailwind plugins like Gallery
    var bgVal = theme.vars['--c-bg'] || theme.vars.bg || '15 19 28';
    var cardVal = theme.vars['--c-obsidian'] || theme.vars.card || '28 31 41';
    var inkVal = theme.vars['--c-ink'] || theme.vars.ink || '223 226 239';
    var inkMutedVal = theme.vars['--c-ink-muted'] || theme.vars.inkMuted || '199 196 215';
    var primaryVal = theme.vars['--c-primary'] || theme.vars.primary || '99 102 241';
    root.style.setProperty('--bg', 'rgb(' + bgVal + ')');
    root.style.setProperty('--card-bg', 'rgb(' + cardVal + ')');
    root.style.setProperty('--text', 'rgb(' + inkVal + ')');
    root.style.setProperty('--text-secondary', 'rgb(' + inkMutedVal + ')');
    root.style.setProperty('--border', 'rgba(255, 255, 255, 0.1)');
    root.style.setProperty('--primary', 'rgb(' + primaryVal + ')');
    if (theme.fontDisplay) root.style.setProperty('--sd-font-display', theme.fontDisplay);
    if (theme.fontBody) root.style.setProperty('--sd-font-body', theme.fontBody);
    root.style.colorScheme = theme.mode === 'light' ? 'light' : 'dark';
    root.setAttribute('data-sd-theme', theme.slug || '');
    root.setAttribute('data-sd-mode', theme.mode === 'light' ? 'light' : 'dark');
    root.classList.toggle('sd-light', theme.mode === 'light');
    var style = document.getElementById('sdcodex-theme-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'sdcodex-theme-style';
    }
    style.textContent = rules();
    // Keep the override last so it wins against Tailwind's generated sheet.
    document.head.appendChild(style);
  }
  function stored() {
    try {
      var raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  var theme = stored();
  if (theme) apply(theme);
  document.addEventListener('DOMContentLoaded', function () {
    var t = theme || stored();
    if (t) apply(t);
    try { window.parent.postMessage({ type: 'sdcodex:theme-ready' }, window.location.origin); }
    catch (e) { /* standalone */ }
  });
  window.addEventListener('message', function (e) {
    if (e.origin !== window.location.origin) return;
    var d = e.data || {};
    if (d.type === 'sdcodex:theme' && d.theme) { theme = d.theme; apply(theme); }
  });
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) { theme = stored(); if (theme) apply(theme); }
  });
})();
</script>"""


_THEME_TOKEN_NAMES = (
    "surface",
    "surface-container",
    "surface-container-low",
    "surface-container-lowest",
    "surface-container-high",
    "surface-container-highest",
    "slate-surface",
    "background",
    "primary",
    "secondary",
    "tertiary",
    "on-surface",
    "on-surface-variant",
    "outline",
    "outline-variant",
    "badge-checkpoint",
    "badge-sdxl",
    "badge-lora",
    "badge-flux",
)

_TOKEN_ALPHA_RE = re.compile(
    r"(?:(hover|focus|focus-visible|active):)?"
    r"(bg|text|border|from|via|to|ring|fill|stroke|divide|placeholder|shadow)-"
    r"(" + "|".join(sorted(_THEME_TOKEN_NAMES, key=len, reverse=True)) + r")/"
    r"(\d{1,3})"
)


def _token_alpha_variants(html: str) -> list[list[str]]:
    """Collect the themed `/opacity` utility classes a page actually uses.

    The bridge can't read Tailwind's generated alpha from a class name, so it
    only needs rules for the combinations present in this document. Emitting a
    rule per found combination keeps the sheet small and preserves translucency
    instead of flattening e.g. `bg-badge-checkpoint/15` into a solid fill.
    """
    seen: list[list[str]] = []
    for match in _TOKEN_ALPHA_RE.finditer(html or ""):
        state, prop, token, frac = match.groups()
        if state == "group-hover":
            continue
        entry = [token, prop, str(int(frac)), state or ""]
        if entry not in seen:
            seen.append(entry)
    return seen


def _inject_theme_bridge(html: str) -> str:
    """Inject the button kit + theme bridge into a plugin page (before </head>)."""
    if 'sdcodex-theme-bridge' in html:
        return html
    entries = _token_alpha_variants(html)
    bridge = _THEME_BRIDGE.replace("__SD_TOKEN_ALPHA__", json.dumps(entries))
    payload = _PLUGIN_UI_CSS + bridge
    idx = html.lower().rfind('</head>')
    if idx == -1:
        return payload + html
    return html[:idx] + payload + html[idx:]


def _plugin_page_file(plugin_id: str, name: str) -> str | None:
    from . import updater as updater_mod

    if not _PAGE_RE.match(plugin_id or "") or not _PAGE_RE.match(name or ""):
        return None
    base = updater_mod.plugin_path(plugin_id)
    if not base:
        return None
    cand = os.path.join(base, "pages", f"{name}.html")
    if os.path.isfile(cand):
        return cand
    return None


@api_v1.get("/plugins/<plugin_id>/page/<name>")
def plugin_page(plugin_id: str, name: str):
    """Serve a plugin's static page (sidebar nav target)."""
    from flask import Response

    _, err = _require_user()
    if err:
        return err
    cand = _plugin_page_file(plugin_id, name)
    if not cand:
        html = _MISSING_PAGE.format(
            title=f"{plugin_id} / {name}",
            detail="This page is not drawn up yet.",
            name=name,
        )
        return Response(html, content_type="text/html")
    with open(cand, encoding="utf-8") as f:
        resp = Response(_inject_theme_bridge(f.read()), content_type="text/html")
    # Plugin pages iterate fast — never let browsers cache them.
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    return resp


@api_v1.get("/plugins/<plugin_id>/settings/<tab>")
def plugin_settings_page(plugin_id: str, tab: str):
    """Serve a plugin's settings tab (pages/settings-<tab>.html, else pages/<tab>.html)."""
    from flask import Response

    _, err = _require_user()
    if err:
        return err
    cand = _plugin_page_file(plugin_id, f"settings-{tab}") or _plugin_page_file(plugin_id, tab)
    if not cand:
        html = _MISSING_PAGE.format(
            title=f"{plugin_id} settings / {tab}",
            detail="This settings tab is not drawn up yet.",
            name=f"settings-{tab}",
        )
        return Response(html, content_type="text/html")
    with open(cand, encoding="utf-8") as f:
        resp = Response(_inject_theme_bridge(f.read()), content_type="text/html")
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    return resp


# ------------------------------------------------------- civitai proxy ---

@api_v1.get("/civitai/<path:subpath>")
def civitai_proxy(subpath: str):
    """Same-origin Civitai relay for production builds.

    Browsers can't call Civitai cross-origin with an API key (preflight 405),
    and Docker has no Vite dev proxy — so the backend forwards with the
    user's key and selected mirror. Authed only.
    """
    import requests

    user, err = _require_user()
    if err:
        return err
    if any(part in ("..", ".") for part in subpath.replace("\\", "/").split("/")):
        return jsonify({"error": "invalid path"}), 400
    mirror_row = db.session.get(Setting, "api_mirror")
    mirror = (mirror_row.value if mirror_row else "") or "civitai.com"
    if mirror not in ("civitai.com", "civitai.red"):
        mirror = "civitai.com"
    headers = {"User-Agent": "SDCodex/1.0 (+https://github.com/LainStable/SDCodex)"}
    # API key validation happens before the key is saved on the user row, so
    # honor the browser's one-request Bearer token. Once saved, normal calls
    # can use the account key stored server-side.
    authorization = (request.headers.get("Authorization") or "").strip()
    if authorization.lower().startswith("bearer "):
        headers["Authorization"] = authorization
    elif user.api_key:
        headers["Authorization"] = f"Bearer {user.api_key}"
    url = f"https://{mirror}/api/v1/{subpath}"
    if request.args:
        url = f"{url}?{urlencode(dict(request.args), doseq=True)}"
    try:
        resp = _civitai_get(url, headers, timeout=(5, 30))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as e:
        return jsonify({"error": f"upstream unreachable: {e}"}), 502
    try:
        body = _read_capped(resp, 50 * 1024 * 1024)
        content_type = resp.headers.get("Content-Type", "application/json")
        status = resp.status_code
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 502
    finally:
        resp.close()
    return (
        body,
        status,
        {"Content-Type": content_type},
    )

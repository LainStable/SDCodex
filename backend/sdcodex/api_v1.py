"""JSON API for the React frontend. Mirrors OldCode routes.py semantics."""

import os

from flask import Blueprint, jsonify, make_response, request

from . import auth, db
from .models import Download, OidcConfig, Setting, User

api_v1 = Blueprint("api_v1", __name__)


def _user_json(u: User) -> dict:
    return {
        "id": u.id,
        "username": u.username,
        "displayName": u.display_name or u.username,
        "email": u.email or "",
        "isAdmin": bool(u.is_admin),
        "authProvider": u.auth_provider,
        "avatar": bool(u.avatar),
    }


def _profile_json(u: User) -> dict:
    out = _user_json(u)
    out["avatarData"] = u.avatar or ""
    return out


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


@api_v1.post("/auth/bootstrap")
def auth_bootstrap():
    """Create the first user (admin). Refused once any user exists."""
    if User.query.count() > 0:
        return jsonify({"error": "users already exist"}), 403
    data = request.get_json(force=True, silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    display = (data.get("displayName") or "").strip() or username
    if not username:
        return jsonify({"error": "username required"}), 400
    if len(password) < 8:
        return jsonify({"error": "password must be at least 8 characters"}), 400
    user = User(
        username=username,
        display_name=display,
        password_hash=auth.hash_password(password),
        auth_provider="local",
        is_admin=True,
        is_active=True,
    )
    db.session.add(user)
    db.session.commit()
    token = auth.create_session(user.id, "local")
    resp = make_response(jsonify({"ok": True, "user": _user_json(user)}))
    auth.set_session_cookie(resp, token)
    return resp


@api_v1.post("/auth/login")
def auth_login():
    data = request.get_json(force=True, silent=True) or {}
    result = auth.authenticate_local(data.get("username"), data.get("password"))
    if not result.get("success"):
        return jsonify({"error": result.get("error", "login failed")}), 401
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
        user.display_name = (data.get("displayName") or "").strip() or user.username
    if "email" in data:
        user.email = (data.get("email") or "").strip()
    if "avatar" in data:
        avatar = data.get("avatar") or ""
        if len(avatar) > 300_000:
            return jsonify({"error": "avatar too large"}), 400
        user.avatar = avatar
    db.session.commit()
    return jsonify({"ok": True, "user": _profile_json(user)})


# ------------------------------------------------------------- settings ---

@api_v1.get("/settings")
def get_settings():
    user, err = _require_user()
    if err:
        return err
    rows = {s.key: (s.value or "") for s in Setting.query.all()}
    return jsonify(
        {
            "dirs": {k: v for k, v in rows.items() if k.startswith("dir_")},
            "colors": {k[6:]: v for k, v in rows.items() if k.startswith("color_")},
            "civitaiApiKey": user.api_key or rows.get("civitai_api_key", ""),
            "apiMirror": rows.get("api_mirror", "civitai.com") or "civitai.com",
            "organizeByBase": rows.get("organize_by_base", "0") == "1",
            "maxParallel": int(rows.get("max_parallel_downloads", "1") or 1),
        }
    )


@api_v1.post("/settings")
def post_settings():
    user, err = _require_user()
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    for key, value in (data.get("dirs") or {}).items():
        if not key.startswith("dir_"):
            continue
        row = db.session.get(Setting, key)
        if row is None:
            row = Setting(key=key)
            db.session.add(row)
        row.value = (value or "").strip()
    for type_name, value in (data.get("colors") or {}).items():
        key = f"color_{type_name}"
        row = db.session.get(Setting, key)
        if row is None:
            row = Setting(key=key)
            db.session.add(row)
        row.value = (value or "").strip()
    if "civitaiApiKey" in data:
        key = (data.get("civitaiApiKey") or "").strip()
        user.api_key = key  # per-user, mirrors OldCode
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
    if not data.get("modelId") or not data.get("versionId"):
        return jsonify({"error": "modelId and versionId required"}), 400
    from .download_manager import download_manager

    task = download_manager.add_task(
        model_id=data["modelId"],
        version_id=data["versionId"],
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
    return jsonify(
        {
            "items": [
                {
                    "id": d.id,
                    "modelId": d.model_id,
                    "versionId": d.version_id,
                    "name": d.name,
                    "type": d.type,
                    "files": d.get_files(),
                }
                for d in rows
            ]
        }
    )


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
                "files": row.get_files(),
            },
        }
    )


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
    return send_file(real)


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
            "total": (1 if core.get("has_update") else 0)
            + len(plugin_updates)
            + (1 if rebuild_required else 0),
        }
    )


@api_v1.post("/updates/core")
def updates_core_apply():
    _, err = _admin_or_401()
    if err:
        return err
    from . import updater as updater_mod

    ok, msg = updater_mod.update_core()
    return jsonify({"ok": ok, "message": msg}), (200 if ok else 409)


@api_v1.post("/system/rebuild")
def system_rebuild():
    """Pull-triggered rebuild: image build + container replace (Docker) or
    backend restart (bare metal). Runs in the background; the frontend polls
    health and reloads."""
    _, err = _admin_or_401()
    if err:
        return err
    from . import rebuilder as rebuilder_mod

    ok, msg = rebuilder_mod.start_rebuild()
    return jsonify({"ok": ok, "message": msg}), (200 if ok else 409)


@api_v1.get("/plugins")
def plugins_list():
    user, err = _require_user()
    if err:
        return err
    from . import updater as updater_mod

    installed = updater_mod.list_installed()
    updates = {p["id"]: p for p in updater_mod.check_plugin_updates()}
    for p in installed:
        p["has_update"] = p["id"] in updates
        if p["id"] in updates:
            p["remote_sha"] = updates[p["id"]].get("remote_sha", "")
    return jsonify({"installed": installed})


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

    data = request.get_json(force=True, silent=True) or {}
    repo_url = (data.get("repo_url") or "").strip()
    if not repo_url:
        return jsonify({"error": "repo_url required"}), 400
    ok, result = updater_mod.install_plugin(repo_url, data.get("volumes") or {})
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

    ok, msg = updater_mod.update_plugin(plugin_id)
    return jsonify({"ok": ok, "message": msg}), (200 if ok else 409)


@api_v1.delete("/plugins/<plugin_id>")
def plugins_uninstall(plugin_id: str):
    _, err = _admin_or_401()
    if err:
        return err
    from . import updater as updater_mod

    ok, msg = updater_mod.uninstall_plugin(plugin_id)
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

    base = updater_mod.plugin_path(plugin_id)
    if not base:
        return jsonify({"error": "Not installed."}), 404
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

    base = updater_mod.plugin_path(plugin_id)
    if not base:
        return jsonify({"error": "Not installed."}), 404
    mf = updater_mod.read_manifest(base) or {"id": plugin_id}
    data = request.get_json(force=True, silent=True) or {}
    values = data.get("volumes") or {}
    resolved = {}
    for v in mf.get("volumes", []):
        if not isinstance(v, dict) or not v.get("env_var"):
            continue
        val = (values.get(v["env_var"]) or v.get("host_path") or "").strip()
        if val:
            resolved[v["env_var"]] = val
    updater_mod.apply_volume_config({"id": mf.get("id", plugin_id), "volumes": mf.get("volumes", [])}, resolved)
    from . import rebuilder as rebuilder_mod

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
        return Response(f.read(), content_type="text/html")


@api_v1.get("/plugins/<plugin_id>/settings/<tab>")
def plugin_settings_page(plugin_id: str, tab: str):
    """Serve a plugin's settings tab (pages/settings-<tab>.html)."""
    from flask import Response

    _, err = _require_user()
    if err:
        return err
    cand = _plugin_page_file(plugin_id, f"settings-{tab}")
    if not cand:
        html = _MISSING_PAGE.format(
            title=f"{plugin_id} settings / {tab}",
            detail="This settings tab is not drawn up yet.",
            name=f"settings-{tab}",
        )
        return Response(html, content_type="text/html")
    with open(cand, encoding="utf-8") as f:
        return Response(f.read(), content_type="text/html")


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
    mirror_row = db.session.get(Setting, "api_mirror")
    mirror = (mirror_row.value if mirror_row else "") or "civitai.com"
    if mirror not in ("civitai.com", "civitai.red"):
        mirror = "civitai.com"
    headers = {"User-Agent": "SDCodex/1.0 (+https://github.com/LainStable/SDCodex)"}
    if user.api_key:
        headers["Authorization"] = f"Bearer {user.api_key}"
    try:
        resp = requests.get(
            f"https://{mirror}/api/v1/{subpath}",
            params=dict(request.args),
            headers=headers,
            timeout=30,
        )
    except Exception as e:
        return jsonify({"error": f"upstream unreachable: {e}"}), 502
    return (
        resp.content,
        resp.status_code,
        {"Content-Type": resp.headers.get("Content-Type", "application/json")},
    )

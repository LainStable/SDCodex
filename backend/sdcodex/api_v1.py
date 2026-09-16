"""JSON API for the React frontend. Mirrors OldCode routes.py semantics."""

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
    return jsonify({"ok": True, "app": "sdcodex", "backend": True})


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
            "civitaiApiKey": user.api_key or rows.get("civitai_api_key", ""),
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
    if "civitaiApiKey" in data:
        key = (data.get("civitaiApiKey") or "").strip()
        user.api_key = key  # per-user, mirrors OldCode
        row = db.session.get(Setting, "civitai_api_key")
        if row is None:
            row = Setting(key="civitai_api_key")
            db.session.add(row)
        row.value = key
    db.session.commit()
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
    from . import oidc as oidc_mod

    return jsonify(
        {"items": [{"id": c.id, "name": c.name} for c in oidc_mod.enabled_configs()]}
    )


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

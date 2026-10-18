"""Assistant + agent tools.

One tool registry backs two surfaces:

* the in-app chat bar (``POST /api/assistant/chat``), and
* the MCP server (``/api/mcp``) that external agents connect to.

Plugins opt in by declaring ``assistant_actions`` in ``plugin.json``; the same
declarations become tools in both surfaces, so an external agent can perform
the actions the UI can.
"""

from __future__ import annotations

import json
import secrets
import time
from contextlib import contextmanager

import requests
from flask import current_app

MAX_TOOL_ROUNDS = 4
REQUEST_TIMEOUT = 60

ASSISTANT_KEYS = ("assistant_base_url", "assistant_model", "assistant_api_key")


# ------------------------------------------------------------- settings ---

def _get_setting(key: str, default: str = "") -> str:
    from .models import Setting

    row = _db().session.get(Setting, key)
    return (row.value if row else default) or default


def _set_setting(key: str, value: str) -> None:
    from .models import Setting

    row = _db().session.get(Setting, key)
    if row is None:
        row = Setting(key=key)
        _db().session.add(row)
    row.value = value


def _db():
    from . import db

    return db


def assistant_settings() -> dict:
    base_url = _get_setting("assistant_base_url").rstrip("/")
    model = _get_setting("assistant_model")
    return {
        "baseUrl": base_url,
        "model": model,
        "apiKeySet": bool(_get_setting("assistant_api_key")),
        "configured": bool(base_url and model),
    }


def save_assistant_settings(data: dict, *, clear_key: bool = False) -> dict:
    if "baseUrl" in data:
        _set_setting("assistant_base_url", str(data.get("baseUrl") or "").strip().rstrip("/"))
    if "model" in data:
        _set_setting("assistant_model", str(data.get("model") or "").strip())
    if clear_key:
        _set_setting("assistant_api_key", "")
    elif "apiKey" in data and str(data.get("apiKey") or "").strip():
        _set_setting("assistant_api_key", str(data["apiKey"]).strip())
    _db().session.commit()
    return assistant_settings()


def _assistant_api_key() -> str:
    return _get_setting("assistant_api_key")


def mcp_settings() -> dict:
    token = _get_setting("mcp_token")
    return {
        "enabled": _get_setting("mcp_enabled") == "1",
        "token": token,
        "path": "/api/mcp",
    }


def save_mcp_settings(data: dict) -> dict:
    if "enabled" in data:
        _set_setting("mcp_enabled", "1" if data.get("enabled") else "0")
    if data.get("rotateToken") or (data.get("enabled") and not _get_setting("mcp_token")):
        _set_setting("mcp_token", secrets.token_urlsafe(32))
    _db().session.commit()
    return mcp_settings()


def mcp_token_valid(token: str) -> bool:
    stored = _get_setting("mcp_token")
    return bool(stored) and bool(token) and secrets.compare_digest(stored, token)


# -------------------------------------------------------- plugin tasks ---

def plugin_tasks(cookie: str = "") -> list[dict]:
    """Running background tasks reported by installed plugins."""
    from . import updater as updater_mod

    tasks = []
    with _plugin_session(cookie) as probe_cookie:
        for plugin in updater_mod.list_installed():
            meta = plugin.get("task_status") or {}
            route = (meta.get("path") or "").strip()
            if not route.startswith("/"):
                continue
            _, payload = _probe(route, probe_cookie)
            if not isinstance(payload, dict) or not payload.get("active"):
                continue
            current = payload.get("current")
            total = payload.get("total")
            tasks.append(
                {
                    "pluginId": plugin["id"],
                    "pluginName": meta.get("label") or plugin.get("name") or plugin["id"],
                    "page": meta.get("page") or plugin.get("entry_page") or "",
                    "state": str(payload.get("state") or "running"),
                    "current": current if isinstance(current, int) else 0,
                    "total": total if isinstance(total, int) else 0,
                    "detail": str(payload.get("detail") or ""),
                    "message": str(payload.get("message") or ""),
                    "startedAt": payload.get("started_at") or 0,
                }
            )
    return tasks


@contextmanager
def _plugin_session(cookie: str):
    """Yield a Cookie header that in-process plugin routes will authorise.

    Browser requests already carry the user's session cookie. Agent requests
    (MCP) authenticate with the instance token instead, so mint a short-lived
    session for an admin user and clean it up afterwards.
    """
    token = None
    if not cookie:
        try:
            from . import auth
            from .models import User

            admin = User.query.filter_by(is_admin=True).first() or User.query.first()
            if admin is not None:
                token = auth.create_session(admin.id, provider="mcp")
                cookie = f"{auth.SESSION_COOKIE}={token}"
        except Exception:
            current_app.logger.warning("could not mint an agent session", exc_info=True)
    try:
        yield cookie
    finally:
        if token:
            try:
                from .models import Session as SessionRow

                row = _db().session.get(SessionRow, token)
                if row is not None:
                    _db().session.delete(row)
                    _db().session.commit()
            except Exception:
                _db().session.rollback()
                current_app.logger.warning("could not clean up the agent session", exc_info=True)


def _probe(path: str, cookie: str, method: str = "GET", body: dict | None = None):
    """Call an in-process plugin route with the caller's own session cookie.

    ``use_cookies=False`` matters: a fresh test client would otherwise strip
    the forwarded Cookie header (its own jar is empty) and the plugin routes
    authenticate from the core session cookie.
    """
    kwargs = {"headers": {"Cookie": cookie}}
    if body is not None:
        kwargs["json"] = body
    response = current_app.test_client(use_cookies=False).open(path, method=method, **kwargs)
    payload = response.get_json(silent=True)
    return response, payload


# --------------------------------------------------------------- tools ---

def _plugin_action_specs(plugin: dict) -> list[dict]:
    actions = plugin.get("assistant_actions")
    if not isinstance(actions, list):
        return []
    out = []
    for action in actions:
        if not isinstance(action, dict) or not action.get("name") or not action.get("path"):
            continue
        out.append(
            {
                "name": str(action["name"]),
                "description": str(action.get("description") or action["name"]),
                "method": str(action.get("method") or "GET").upper(),
                "path": str(action["path"]),
                "confirm": bool(action.get("confirm")),
                "params": [p for p in (action.get("params") or []) if isinstance(p, dict)],
            }
        )
    return out


def plugin_inventory(include_tasks: bool = True, cookie: str = "") -> list[dict]:
    """Installed plugins with their pages, declared actions and live tasks."""
    from . import updater as updater_mod

    tasks = {t["pluginId"]: t for t in plugin_tasks(cookie)} if include_tasks else {}
    out = []
    for plugin in updater_mod.list_installed():
        actions = _plugin_action_specs(plugin)
        out.append(
            {
                "id": plugin["id"],
                "name": plugin.get("name") or plugin["id"],
                "version": plugin.get("version") or "",
                "description": plugin.get("description") or "",
                "pages": [n.get("page") for n in plugin.get("nav_items") or [] if n.get("page")]
                or ([plugin.get("entry_page")] if plugin.get("entry_page") else []),
                "actions": [
                    {"name": a["name"], "description": a["description"], "confirm": a["confirm"]}
                    for a in actions
                ],
                "running": tasks.get(plugin["id"]),
            }
        )
    return out


CORE_TOOLS = [
    {
        "name": "list_plugins",
        "description": (
            "List the installed SDCodex plugins with their functions/tasks, pages and any "
            "running task progress. Use this to answer questions about what this install can do."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "plugin_id": {"type": "string", "description": "Optional plugin id for one plugin."}
            },
        },
    },
    {
        "name": "search_models",
        "description": (
            "Search Civitai models and show the results in the Model Explorer grid. "
            "Use for requests like 'find SDXL anime checkpoints'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search text, e.g. 'anime', 'photoreal'."},
                "type": {
                    "type": "string",
                    "description": "Model type filter: All, Checkpoint, LORA, TextualInversion, VAE, Controlnet, Upscaler, LoCon, Hypernetwork, MotionModule, DoRA.",
                },
                "base_model": {
                    "type": "string",
                    "description": "Base model filter, e.g. 'SDXL 1.0', 'Pony', 'Flux.1 D', 'Illustrious'.",
                },
                "sort": {
                    "type": "string",
                    "description": "Highest Rated, Most Downloaded, or Newest.",
                },
                "limit": {"type": "integer", "description": "How many results to return (1-50)."},
            },
        },
    },
    {
        "name": "run_plugin_task",
        "description": (
            "Run a task exposed by an installed plugin (see list_plugins for names). "
            "Actions marked confirm=true change something on disk and need confirmation."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "plugin_id": {"type": "string", "description": "Plugin id, e.g. 'gallery'."},
                "action": {"type": "string", "description": "Action name from list_plugins."},
                "params": {"type": "object", "description": "Action parameters (string values)."},
            },
            "required": ["plugin_id", "action"],
        },
    },
]


def tool_schemas() -> list[dict]:
    """OpenAI-style function schemas for every available tool."""
    from . import updater as updater_mod

    tools = list(CORE_TOOLS)
    for plugin in updater_mod.list_installed():
        for action in _plugin_action_specs(plugin):
            properties = {}
            required = []
            for param in action["params"]:
                name = str(param.get("name") or "").strip()
                if not name:
                    continue
                properties[name] = {
                    "type": param.get("type") or "string",
                    "description": str(param.get("description") or ""),
                }
                if param.get("required"):
                    required.append(name)
            tools.append(
                {
                    "name": f"plugin__{plugin['id']}__{action['name']}".replace("-", "_"),
                    "description": (
                        f"[{plugin.get('name') or plugin['id']}] {action['description']}"
                        + (" (needs confirmation)" if action["confirm"] else "")
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": properties,
                        **( {"required": required} if required else {} ),
                    },
                }
            )
    return tools


def _find_plugin(plugin_id: str):
    from . import updater as updater_mod

    for plugin in updater_mod.list_installed():
        if plugin["id"] == plugin_id:
            return plugin
    return None


def tool_is_destructive(name: str) -> bool:
    if name == "run_plugin_task":
        return True
    if not name.startswith("plugin__"):
        return False
    for plugin in _iter_plugins():
        for action in _plugin_action_specs(plugin):
            if _plugin_tool_name(plugin["id"], action["name"]) == name and action["confirm"]:
                return True
    return False


def _iter_plugins():
    from . import updater as updater_mod

    return updater_mod.list_installed()


def _plugin_tool_name(plugin_id: str, action_name: str) -> str:
    return f"plugin__{plugin_id}__{action_name}".replace("-", "_")


def _civitai_search(args: dict) -> dict:
    from . import api as civitai_api

    base_models = []
    value = (args.get("base_model") or "").strip()
    if value and value.lower() != "all":
        base_models.append(value)
    types = (args.get("type") or "").strip()
    sort = (args.get("sort") or "Highest Rated").strip()
    query = (args.get("query") or "").strip()
    try:
        limit = max(1, min(50, int(args.get("limit") or 12)))
    except (TypeError, ValueError):
        limit = 12

    params = {"limit": limit, "sort": sort}
    if query:
        params["query"] = query
    if types and types.lower() != "all":
        params["types"] = types
    if base_models:
        params["baseModels"] = base_models

    api_key = ""
    user = None
    try:
        from . import auth

        user = auth.current_user()
    except Exception:
        user = None
    if user is not None:
        api_key = user.api_key or ""
    if not api_key:
        api_key = _get_setting("civitai_api_key")

    data = civitai_api.get_models(params, api_key or None)
    items = data.get("items", []) if isinstance(data, dict) else []
    results = []
    for item in items[:limit]:
        versions = item.get("modelVersions") or [{}]
        results.append(
            {
                "id": item.get("id"),
                "name": item.get("name"),
                "type": item.get("type"),
                "nsfw": item.get("nsfw"),
                "downloads": item.get("stats", {}).get("downloadCount"),
                "baseModel": versions[0].get("baseModel"),
                "creator": (item.get("creator") or {}).get("username"),
            }
        )
    return {
        "ok": True,
        "count": len(results),
        "results": results,
        "action": {
            "type": "search",
            "params": {
                "q": query,
                "type": types or "All",
                "baseModels": base_models,
                "sort": sort if sort in ("Highest Rated", "Most Downloaded", "Newest") else "Highest Rated",
            },
        },
    }


def call_tool(name: str, args: dict, *, cookie: str = "", confirmed: bool = False) -> dict:
    """Execute one tool. Returns the tool result (and any UI action)."""
    args = args if isinstance(args, dict) else {}
    if name == "list_plugins":
        plugin_id = (args.get("plugin_id") or "").strip()
        plugins = plugin_inventory(cookie=cookie)
        if plugin_id:
            plugins = [p for p in plugins if p["id"] == plugin_id]
        return {"ok": True, "plugins": plugins}
    if name == "search_models":
        try:
            return _civitai_search(args)
        except requests.RequestException as error:
            return {"ok": False, "error": f"Civitai search failed: {error}"}
    if name == "run_plugin_task":
        return _run_plugin_task(args, cookie=cookie, confirmed=confirmed)
    if name.startswith("plugin__"):
        plugin_id = name[len("plugin__"):]
        action_name = ""
        plugin = None
        for candidate in _iter_plugins():
            for action in _plugin_action_specs(candidate):
                if _plugin_tool_name(candidate["id"], action["name"]) == name:
                    plugin, action_name = candidate, action["name"]
                    break
        if plugin is None:
            return {"ok": False, "error": f"Unknown action '{name}'."}
        return _run_plugin_task(
            {"plugin_id": plugin["id"], "action": action_name, "params": args},
            cookie=cookie,
            confirmed=confirmed,
        )
    return {"ok": False, "error": f"Unknown tool '{name}'."}


def _run_plugin_task(args: dict, *, cookie: str, confirmed: bool) -> dict:
    plugin_id = (args.get("plugin_id") or "").strip()
    action_name = (args.get("action") or "").strip()
    params = args.get("params") if isinstance(args.get("params"), dict) else {}
    plugin = _find_plugin(plugin_id)
    if plugin is None:
        return {"ok": False, "error": f"Plugin '{plugin_id}' is not installed."}
    action = next((a for a in _plugin_action_specs(plugin) if a["name"] == action_name), None)
    if action is None:
        return {"ok": False, "error": f"Plugin '{plugin_id}' has no action '{action_name}'."}
    if action["confirm"] and not confirmed:
        return {
            "ok": False,
            "needsConfirmation": True,
            "pluginId": plugin_id,
            "action": action_name,
            "params": params,
            "description": action["description"],
            "message": f"{plugin.get('name') or plugin_id}: {action['description']} — run it?",
        }

    path = action["path"]
    body = {}
    query = {}
    values = {str(k): str(v) for k, v in params.items()}
    for key, value in values.items():
        placeholder = "{%s}" % key
        if placeholder in path:
            path = path.replace(placeholder, value)
        elif action["method"] == "GET":
            query[key] = value
        else:
            body[key] = value
    if query:
        separator = "&" if "?" in path else "?"
        path = path + separator + "&".join(f"{k}={requests.utils.quote(v)}" for k, v in query.items())

    try:
        with _plugin_session(cookie) as probe_cookie:
            response, payload = _probe(
                path,
                probe_cookie,
                method=action["method"],
                body=body if action["method"] != "GET" else None,
            )
    except Exception as error:
        return {"ok": False, "error": f"{action['name']} failed: {error}"}
    if response.status_code >= 400:
        detail = payload.get("error") if isinstance(payload, dict) else None
        return {
            "ok": False,
            "error": detail or f"{action['name']} failed with HTTP {response.status_code}.",
        }
    return {
        "ok": True,
        "pluginId": plugin_id,
        "action": action_name,
        "result": payload if payload is not None else {"status": response.status_code},
    }


# ---------------------------------------------------------------- chat ---

def _api_root(settings: dict) -> str:
    """Endpoint root without a trailing /v1.

    The settings placeholder shows a URL *with* /v1 (LM Studio style) while
    the code appends /v1/... itself — accept both forms instead of producing
    a doubled /v1/v1/... path.
    """
    base = (settings.get("baseUrl") or "").strip().rstrip("/")
    if base.lower().endswith("/v1"):
        base = base[: -len("/v1")].rstrip("/")
    return base


def _chat_completion(settings: dict, messages: list[dict], tools: list[dict]) -> dict:
    headers = {"Content-Type": "application/json"}
    api_key = _assistant_api_key()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = {"model": settings["model"], "messages": messages, "stream": False}
    if tools:
        payload["tools"] = [{"type": "function", "function": tool} for tool in tools]
        payload["tool_choice"] = "auto"
    response = requests.post(
        f"{_api_root(settings)}/v1/chat/completions",
        json=payload,
        headers=headers,
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    return response.json()


def _system_prompt() -> str:
    plugins = plugin_inventory(include_tasks=False)
    lines = [
        "You are the SDCodex assistant, embedded in a model-management workstation.",
        "You can search Civitai (results open in the Model Explorer grid) and run tasks",
        "exposed by installed plugins. Prefer calling tools over guessing.",
        "Installed plugins and their actions:",
    ]
    for plugin in plugins:
        actions = ", ".join(a["name"] for a in plugin["actions"]) or "no declared actions"
        lines.append(f"- {plugin['name']} ({plugin['id']} v{plugin['version']}): {actions}")
    if not plugins:
        lines.append("- (none installed)")
    return "\n".join(lines)


def chat(messages: list[dict], *, cookie: str = "", approved: dict | None = None) -> dict:
    """Run one assistant turn, executing tool calls as the model asks for them.

    ``approved`` carries a confirmed call from the UI
    (``{"name": ..., "args": {...}}``) so a task that needed confirmation runs.
    """
    settings = assistant_settings()
    if not settings["configured"]:
        return {"ok": False, "error": "Set the assistant endpoint and model in Settings → System first."}

    history = [{"role": "system", "content": _system_prompt()}]
    for message in messages[-20:]:
        role = message.get("role")
        content = message.get("content")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            history.append({"role": role, "content": content})
    if not history or all(m["role"] != "user" for m in history):
        return {"ok": False, "error": "Ask a question first."}

    tools = tool_schemas()
    actions: list[dict] = []
    notes: list[str] = []
    approved_names = {approved["name"]} if approved and isinstance(approved.get("name"), str) else set()
    ran_this_turn: dict[str, dict] = {}

    def execute(name: str, args: dict, confirmed: bool) -> dict:
        if name in ran_this_turn:
            return ran_this_turn[name]
        result = call_tool(name, args, cookie=cookie, confirmed=confirmed)
        if isinstance(result, dict) and result.get("action"):
            actions.append(result["action"])
        if isinstance(result, dict) and result.get("needsConfirmation"):
            return result
        if tool_is_destructive(name):
            # Never run a confirmed task twice in one turn.
            ran_this_turn[name] = result
        notes.append(name)
        return result

    # A confirmation the UI already granted runs before asking the model again.
    if approved and isinstance(approved.get("name"), str):
        result = execute(approved["name"], approved.get("args") or {}, True)
        history.append(
            {
                "role": "user",
                "content": (
                    f"[the user confirmed running {approved['name']}] "
                    f"Result: {json.dumps(result)[:4000]}"
                ),
            }
        )

    for _ in range(MAX_TOOL_ROUNDS):
        try:
            data = _chat_completion(settings, history, tools)
        except requests.RequestException as error:
            return {"ok": False, "error": f"Assistant request failed: {error}"}
        except ValueError as error:
            return {"ok": False, "error": f"Assistant returned invalid JSON: {error}"}

        choices = data.get("choices") or []
        if not choices:
            return {"ok": False, "error": "Assistant returned no choices."}
        message = choices[0].get("message") or {}
        tool_calls = message.get("tool_calls") or []
        if not tool_calls:
            return {
                "ok": True,
                "reply": (message.get("content") or "").strip(),
                "actions": actions,
                "toolsUsed": notes,
            }

        history.append(message)
        for call in tool_calls:
            function = call.get("function") or {}
            name = function.get("name") or ""
            try:
                args = json.loads(function.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            if tool_is_destructive(name) and name not in approved_names:
                # Hand it back to the UI instead of running it unattended.
                destructive = _describe_destructive(name, args)
                return {
                    "ok": True,
                    "reply": (message.get("content") or "").strip(),
                    "actions": actions,
                    "toolsUsed": notes,
                    "pending": destructive,
                }
            result = execute(name, args if isinstance(args, dict) else {}, True)
            history.append(
                {
                    "role": "tool",
                    "tool_call_id": call.get("id") or "",
                    "content": json.dumps(result)[:8000],
                }
            )

    return {
        "ok": True,
        "reply": "I stopped after several tool calls — ask me to continue if you need more.",
        "actions": actions,
        "toolsUsed": notes,
    }


def _describe_destructive(name: str, args: dict) -> dict:
    """Human-readable preview of a task that needs the user's go-ahead."""
    if name == "run_plugin_task":
        plugin = _find_plugin(str(args.get("plugin_id") or ""))
        action = (args.get("action") or "").strip()
        description = action
        for spec in _plugin_action_specs(plugin) if plugin else []:
            if spec["name"] == action:
                description = spec["description"]
        return {
            "tool": name,
            "args": args,
            "pluginId": args.get("plugin_id"),
            "action": action,
            "params": args.get("params") or {},
            "description": description,
            "message": f"{plugin.get('name') if plugin else args.get('plugin_id')}: {description}",
        }
    if name.startswith("plugin__"):
        for plugin in _iter_plugins():
            for spec in _plugin_action_specs(plugin):
                if _plugin_tool_name(plugin["id"], spec["name"]) == name:
                    return {
                        "tool": name,
                        "args": args,
                        "pluginId": plugin["id"],
                        "action": spec["name"],
                        "params": args,
                        "description": spec["description"],
                        "message": f"{plugin.get('name') or plugin['id']}: {spec['description']}",
                    }
    return {"tool": name, "args": args, "description": name, "message": f"Run {name}?"}


def test_connection() -> dict:
    """Ping the configured endpoint (models list, then a tiny completion)."""
    settings = assistant_settings()
    if not settings["baseUrl"]:
        return {"ok": False, "error": "Set the endpoint URL first."}
    headers = {"Content-Type": "application/json"}
    api_key = _assistant_api_key()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    started = time.time()
    root = _api_root(settings)
    models: list[str] = []
    try:
        response = requests.get(f"{root}/v1/models", headers=headers, timeout=15)
        response.raise_for_status()
        payload = response.json()
        models = [m.get("id") for m in payload.get("data", []) if isinstance(m, dict)]
    except (requests.RequestException, ValueError) as error:
        # Older Ollama servers only expose the native tags endpoint.
        try:
            fallback = requests.get(f"{root}/api/tags", headers=headers, timeout=15)
            fallback.raise_for_status()
            tags = fallback.json().get("models", [])
            models = [m.get("name") for m in tags if isinstance(m, dict) and m.get("name")]
        except (requests.RequestException, ValueError):
            return {"ok": False, "error": f"Endpoint unreachable: {error}"}
    return {
        "ok": True,
        "models": [m for m in models if m][:100],
        "latencyMs": int((time.time() - started) * 1000),
        "model": settings["model"],
    }

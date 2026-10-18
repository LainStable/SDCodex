"""Model Context Protocol server (Streamable-HTTP subset).

Exposes the same tool registry as the in-app assistant (``assistant.py``) so an
external agent can search Civitai and run the plugin actions this install
declares. Enabled and token-protected from Settings → System.
"""

from __future__ import annotations

import json

PROTOCOL_VERSION = "2025-06-18"
SERVER_NAME = "sdcodex"


def _error(message_id, code: int, message: str, data=None) -> dict:
    error = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": message_id, "error": error}


def _result(message_id, result) -> dict:
    return {"jsonrpc": "2.0", "id": message_id, "result": result}


def _server_version() -> str:
    try:
        from . import updater as updater_mod

        return updater_mod.local_core_version()
    except Exception:
        return "0.0.0"


def handle_message(message, cookie: str = "") -> dict | None:
    """Handle one JSON-RPC message; returns a response dict (None for notifications)."""
    from . import assistant

    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        return _error(None, -32600, "Invalid Request")

    method = message.get("method")
    message_id = message.get("id")
    is_notification = "id" not in message

    if method == "initialize":
        params = message.get("params") or {}
        return _result(
            message_id,
            {
                "protocolVersion": params.get("protocolVersion") or PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": _server_version()},
                "instructions": (
                    "SDCodex exposes its installed plugin actions and Civitai search. "
                    "Call list_plugins to discover what this install can do."
                ),
            },
        )
    if method in ("notifications/initialized", "notifications/cancelled"):
        return None
    if method == "ping":
        return _result(message_id, {})
    if method == "tools/list":
        tools = []
        for tool in assistant.tool_schemas():
            tools.append(
                {
                    "name": tool["name"],
                    "description": tool.get("description") or "",
                    "inputSchema": tool.get("parameters") or {"type": "object", "properties": {}},
                }
            )
        return _result(message_id, {"tools": tools})
    if method == "tools/call":
        params = message.get("params") or {}
        name = params.get("name")
        if not isinstance(name, str) or not name:
            return _error(message_id, -32602, "Invalid params: 'name' is required")
        arguments = params.get("arguments")
        if not isinstance(arguments, dict):
            arguments = {}
        try:
            result = assistant.call_tool(name, arguments, cookie=cookie, confirmed=True)
        except Exception as error:  # never leak a traceback into the protocol
            result = {"ok": False, "error": str(error)}
        text = json.dumps(result, indent=2, default=str)
        payload = {"content": [{"type": "text", "text": text}]}
        if isinstance(result, dict) and not result.get("ok", True):
            payload["isError"] = True
        return _result(message_id, payload)
    if method in ("resources/list", "prompts/list", "resources/templates/list"):
        key = {
            "resources/list": "resources",
            "prompts/list": "prompts",
            "resources/templates/list": "resourceTemplates",
        }[method]
        return _result(message_id, {key: []})

    if is_notification:
        return None
    return _error(message_id, -32601, f"Method not found: {method}")


def handle_body(body: bytes, cookie: str = "") -> tuple[bytes, int, bool]:
    """Handle a raw request body.

    Returns ``(payload_bytes, http_status, is_json)``.
    """
    try:
        message = json.loads(body.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError):
        return (
            json.dumps(_error(None, -32700, "Parse error")).encode(),
            400,
            True,
        )

    if isinstance(message, list):
        responses = []
        for item in message:
            response = handle_message(item, cookie=cookie)
            if response is not None:
                responses.append(response)
        if not responses:
            return b"", 202, False
        return json.dumps(responses).encode(), 200, True

    response = handle_message(message, cookie=cookie)
    if response is None:
        return b"", 202, False
    return json.dumps(response).encode(), 200, True

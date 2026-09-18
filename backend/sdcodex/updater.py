"""Git-based core/plugin updates and plugin installs.

Slim port of OldCode plugin_manager.py flows, adapted to the new layout:

* core updates: ``git pull`` the repo (works bare-metal and in Docker, where
  the repo is mounted rw at /app).
* plugin updates/installs: git clone/pull into the plugins dir.
* plugin ``requirements.txt`` files merge into ``plugin-requirements.txt``
  (tracked-ignored), separate from core ``requirements.txt``.
* plugin volumes/env land in ``.env`` + ``docker-compose.override.yml``
  (both git-ignored, so pulls never clobber them).
"""

import json
import logging
import os
import re
import shutil
import subprocess
import threading

import requests

logger = logging.getLogger(__name__)

HUB_URL = os.environ.get(
    "PLUGIN_HUB_URL",
    "https://raw.githubusercontent.com/LainStable/SDCodex-Plugin-Hub/main/plugins.json",
)


def root_dir() -> str:
    return os.environ.get("SDCODEX_ROOT") or os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..")
    )


def plugins_dir() -> str:
    d = os.environ.get("PLUGINS_DIR") or os.path.join(root_dir(), "plugins")
    os.makedirs(d, exist_ok=True)
    return d


def _git(args: list, cwd: str, timeout: int = 120) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    # Mounted checkouts are owned by the host UID, which makes git refuse
    # to operate ("dubious ownership") — seen live in the Docker container.
    return subprocess.run(
        ["git", "-c", "safe.directory=*", *args],
        cwd=cwd, capture_output=True, text=True, env=env, timeout=timeout,
    )


def local_rev(path: str) -> str:
    try:
        r = _git(["rev-parse", "HEAD"], cwd=path)
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""

def _detect_remote(path: str) -> str:
    """Return the best remote to pull from: prefer 'origin', fall back to 'upstream', else first."""
    try:
        r = _git(["remote"], cwd=path)
        if r.returncode != 0:
            return "origin"
        remotes = [l.strip() for l in r.stdout.splitlines() if l.strip()]
        if not remotes:
            return "origin"
        for preferred in ("origin", "upstream"):
            if preferred in remotes:
                return preferred
        return remotes[0]
    except Exception:
        return "origin"


def remote_rev(repo_path_or_url: str) -> str:
    """Remote HEAD sha via the local remote (no API tokens needed)."""
    try:
        if os.path.isdir(os.path.join(repo_path_or_url, ".git")):
            remote = _detect_remote(repo_path_or_url)
            r = _git(["ls-remote", remote, "HEAD"], cwd=repo_path_or_url)
        else:
            r = _git(["ls-remote", repo_path_or_url, "HEAD"], cwd=root_dir())
        if r.returncode != 0:
            return ""
        return r.stdout.split()[0]
    except Exception:
        return ""


def is_clean(path: str) -> bool:
    try:
        r = _git(["status", "--porcelain"], cwd=path)
        return r.returncode == 0 and not r.stdout.strip()
    except Exception:
        return False


def _parse_version(v: str) -> tuple:
    parts = []
    for p in (v or "").strip().lstrip("v").split("."):
        try:
            parts.append(int(p))
        except ValueError:
            parts.append(0)
    return tuple(parts) or (0,)


def local_core_version() -> str:
    """This checkout's version (VERSION file, bumped every core push)."""
    try:
        with open(os.path.join(root_dir(), "VERSION"), encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return "0.0.0"


# ------------------------------------------------------------------ core ---

def check_core() -> dict:
    """Compare the local VERSION file against the hub's core version.

    The hub (plugins.json `core.version`, bumped every core push) is the
    source of truth — no git/ssh needed inside containers.
    """
    local = local_core_version()
    remote = ""
    try:
        r = requests.get(HUB_URL, timeout=15)
        if r.ok:
            remote = ((r.json().get("core") or {}).get("version") or "").strip()
    except Exception as e:
        logger.warning("Core update check failed: %s", e)
    return {
        "local_version": local,
        "remote_version": remote,
        "has_update": bool(local and remote and _parse_version(remote) > _parse_version(local)),
    }


def update_core() -> tuple[bool, str]:
    root = root_dir()
    if not os.path.isdir(os.path.join(root, ".git")):
        return False, "Not a git checkout — cannot self-update."
    if not is_clean(root):
        return False, "Working tree has local changes — commit or stash first."
    remote = _detect_remote(root)
    try:
        r = _git(["pull", "--ff-only", remote], cwd=root)
        if r.returncode != 0:
            return False, (r.stderr or r.stdout).strip()[:500]
        return True, (r.stdout or "Already up to date.").strip()[:500]
    except Exception as e:
        return False, str(e)


# --------------------------------------------------------------- plugins ---

def normalize_github_url(url: str) -> tuple[str, str]:
    """Return (owner/repo short name, canonical https url)."""
    u = (url or "").strip().rstrip("/").removesuffix(".git")
    m = re.search(r"github\.com/([^/]+/[^/]+)", u)
    if m:
        short = m.group(1)
        return short, f"https://github.com/{short}"
    m = re.match(r"([^/]+/[^/]+)$", u)
    if m:
        return m.group(1), f"https://github.com/{m.group(1)}"
    return u, u


def read_manifest(path: str) -> dict | None:
    mf = os.path.join(path, "plugin.json")
    try:
        with open(mf, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def plugin_path(plugin_id: str) -> str | None:
    """Install dir for a plugin id (matches manifest, not dirname)."""
    base = plugins_dir()
    if not os.path.isdir(base):
        return None
    for item in sorted(os.listdir(base)):
        p = os.path.join(base, item)
        if not os.path.isdir(p):
            continue
        mf = read_manifest(p)
        if mf and mf.get("id", item) == plugin_id:
            return p
    return None


def list_installed() -> list:
    out = []
    base = plugins_dir()
    if not os.path.isdir(base):
        return out
    for item in sorted(os.listdir(base)):
        p = os.path.join(base, item)
        if not os.path.isdir(p):
            continue
        mf = read_manifest(p)
        if not mf:
            continue
        out.append(
            {
                "id": mf.get("id", item),
                "name": mf.get("name", item),
                "version": mf.get("version", ""),
                "description": mf.get("description", ""),
                "repository": mf.get("repository", ""),
                "icon": mf.get("icon", ""),
                "nav_items": mf.get("nav_items", []) if isinstance(mf.get("nav_items"), list) else [],
                "settings": mf.get("settings", []) if isinstance(mf.get("settings"), list) else [],
                "path": p,
                "local_sha": local_rev(p),
            }
        )
    return out


def load_plugins(app) -> list:
    """Import each installed plugin's entrypoint (``module:func``) and init it.

    OldCode convention: ``init(app, db)``. Missing/bad entrypoints are
    skipped (page-only plugins) — never fatal to core boot.
    """
    loaded = []
    for p in list_installed():
        mf = read_manifest(p["path"]) or {}
        ep = (mf.get("entrypoint") or "").strip()
        if not ep or ":" not in ep:
            continue
        mod_name, func_name = ep.split(":", 1)
        try:
            import importlib
            import sys as _sys

            if p["path"] not in _sys.path:
                _sys.path.insert(0, p["path"])
            mod = importlib.import_module(mod_name)
            fn = getattr(mod, func_name)
            from . import db as _db

            try:
                fn(app, _db, mf)
            except TypeError:
                fn(app, _db)
            loaded.append(p["id"])
        except Exception as e:
            logger.warning("Plugin '%s' init skipped: %s", p["id"], e)
    return loaded


def check_plugin_updates() -> list:
    """Compare each git-backed plugin against its remote HEAD."""
    updates = []
    for p in list_installed():
        path = p["path"]
        if not os.path.isdir(os.path.join(path, ".git")):
            continue
        remote = remote_rev(path)
        if remote and p["local_sha"] and remote != p["local_sha"]:
            updates.append({**p, "remote_sha": remote, "has_update": True})
    return updates


def update_plugin(plugin_id: str) -> tuple[bool, str]:
    target = plugin_path(plugin_id)
    if not target or not os.path.isdir(os.path.join(target, ".git")):
        return False, "Not a git checkout — reinstall the plugin."
    if not is_clean(target):
        return False, "Plugin has local changes — reinstall instead."
    try:
        r = _git(["pull", "--ff-only"], cwd=target)
        if r.returncode != 0:
            return False, (r.stderr or r.stdout).strip()[:500]
        return True, (r.stdout or "Already up to date.").strip()[:500]
    except Exception as e:
        return False, str(e)


def _github_token() -> str:
    try:
        from .models import Setting  # local import: needs app context
        from . import db

        row = db.session.get(Setting, "github_token")
        if row and row.value:
            return row.value
    except Exception:
        pass
    return os.environ.get("GITHUB_TOKEN", "")


def _merge_requirements(root: str, plugin_id: str, plugin_req: str) -> None:
    """Append new plugin deps to plugin-requirements.txt (dedup by package)."""
    if not os.path.exists(plugin_req):
        return
    req_file = os.path.join(root, "plugin-requirements.txt")
    existing: list = []
    if os.path.exists(req_file) and not os.path.isdir(req_file):
        try:
            with open(req_file, encoding="utf-8") as f:
                existing = f.readlines()
        except Exception as e:
            logger.error("Reading plugin-requirements.txt: %s", e)
    pkgs = set()
    for line in existing:
        s = line.strip()
        if s and not s.startswith("#"):
            pkgs.add(re.split(r"[=<>~!]", s)[0].strip().lower())
    try:
        with open(plugin_req, encoding="utf-8") as f:
            plugin_lines = f.readlines()
    except Exception as e:
        logger.error("Reading plugin requirements: %s", e)
        return
    new_reqs = []
    for line in plugin_lines:
        s = line.strip()
        if s and not s.startswith("#"):
            name = re.split(r"[=<>~!]", s)[0].strip().lower()
            if name not in pkgs:
                new_reqs.append(s)
                pkgs.add(name)
    if not new_reqs:
        return
    content = "".join(existing)
    if content and not content.endswith("\n"):
        content += "\n"
    content += f"\n# [{plugin_id}]\n" + "\n".join(new_reqs) + "\n"
    try:
        with open(req_file, "w", encoding="utf-8") as f:
            f.write(content)
    except Exception as e:
        logger.error("Writing plugin-requirements.txt: %s", e)


def install_plugin(repo_url: str, volume_paths: dict | None = None) -> tuple[bool, str | dict]:
    """Clone a plugin, merge requirements, configure volumes. Returns manifest."""
    short, canonical = normalize_github_url(repo_url)
    repo_name = short.split("/")[-1] if "/" in short else short
    target = os.path.join(plugins_dir(), repo_name.lower())
    token = _github_token()

    if os.path.isdir(os.path.join(target, ".git")):
        r = _git(["pull", "--ff-only"], cwd=target)
        if r.returncode != 0:
            return False, f"Update failed: {(r.stderr or r.stdout).strip()[:300]}"
    else:
        if os.path.exists(target):
            shutil.rmtree(target)
        # Anonymous first (public repos); token only as fallback for private
        # repos — a stale/invalid token must never break public clones.
        r = _git(["clone", canonical, target], cwd=root_dir())
        if r.returncode != 0 and token:
            clone_url = f"https://x-access-token:{token}@github.com/{short}.git"
            r = _git(["clone", clone_url, target], cwd=root_dir())
        if r.returncode != 0:
            r = _git(["clone", "-b", "master", canonical, target], cwd=root_dir())
            if r.returncode != 0:
                msg = f"Clone failed: {(r.stderr or r.stdout).strip()[:300]}"
                if not token:
                    msg += " Private repo? Set GITHUB_TOKEN."
                return False, msg

    manifest = read_manifest(target) or {"id": repo_name.lower(), "name": repo_name}
    plugin_id = manifest.get("id", repo_name.lower())
    root = root_dir()

    # Default host paths come from the manifest (OldCode convention); explicit
    # caller values win.
    volume_values = dict(volume_paths or {})
    for v in manifest.get("volumes", []):
        if not isinstance(v, dict) or not v.get("env_var"):
            continue
        var = v["env_var"]
        if not (volume_values.get(var) or "").strip():
            volume_values[var] = (v.get("host_path") or "").strip()
    apply_volume_config({"id": plugin_id, "volumes": manifest.get("volumes", [])}, volume_values)

    req_path = os.path.join(target, "requirements.txt")
    if os.path.exists(req_path):
        _merge_requirements(root, plugin_id, req_path)

        def _bg_install():
            try:
                res = subprocess.run(
                    [__import__("sys").executable, "-m", "pip", "install", "--no-cache-dir", "-r", req_path],
                    capture_output=True, text=True, timeout=600,
                )
                if res.returncode != 0:
                    logger.warning("Plugin pip install failed for '%s': %s", plugin_id, res.stderr[:300])
            except Exception as e:
                logger.warning("Plugin pip install error for '%s': %s", plugin_id, e)

        threading.Thread(target=_bg_install, daemon=True).start()

    volumes = manifest.get("volumes", [])
    needed = []
    for v in volumes:
        if not isinstance(v, dict) or not v.get("env_var"):
            continue
        vv = dict(v)
        vv["host_path"] = volume_values.get(vv["env_var"], vv.get("host_path", ""))
        needed.append(vv)
    return True, {"id": plugin_id, "name": manifest.get("name", plugin_id), "volumes": needed}


def uninstall_plugin(plugin_id: str) -> tuple[bool, str]:
    target = plugin_path(plugin_id)
    if not target or not os.path.isdir(target):
        return False, "Not installed."
    manifest = read_manifest(target) or {}
    try:
        remove_volume_config(plugin_id)
        remove_env_keys(
            [v.get("env_var") for v in manifest.get("volumes", []) if isinstance(v, dict) and v.get("env_var")]
        )
        shutil.rmtree(target)
    except Exception as e:
        return False, str(e)
    # Drop its requirements block.
    req_file = os.path.join(root_dir(), "plugin-requirements.txt")
    if os.path.exists(req_file):
        try:
            with open(req_file, encoding="utf-8") as f:
                content = f.read()
            pattern = re.compile(rf"\n?#\s*\[{re.escape(plugin_id)}\].*?(?=(\n#\s*\[|\Z))", re.DOTALL)
            with open(req_file, "w", encoding="utf-8") as f:
                f.write(pattern.sub("", content))
        except Exception as e:
            logger.error("Removing plugin requirements: %s", e)
    return True, f"Plugin '{plugin_id}' removed. Restart/rebuild to drop its mounts."


# ------------------------------------------------- .env + override I/O ---

OVERRIDE_SKELETON = """# Plugin mounts (volumes + environment) are written here by SDCodex Settings ->
# Plugins. Docker Compose auto-merges this file with docker-compose.yml, so the
# core docker-compose.yml stays core-only and is never modified at runtime.
services:
  sdcodex:
    volumes:
      # --- PLUGIN VOLUMES START ---
      # (Installed plugin volume mounts are appended here by Settings -> Plugins)
    environment:
      # --- PLUGIN ENV START ---
      # (Installed plugin env vars are appended here by Settings -> Plugins)
"""

VOL_START = "      # --- PLUGIN VOLUMES START ---"
ENV_START = "      # --- PLUGIN ENV START ---"


def _ensure_markers(text: str) -> str:
    if VOL_START not in text or ENV_START not in text:
        if not text.endswith("\n"):
            text += "\n"
        text += f"    volumes:\n{VOL_START}\n    environment:\n{ENV_START}\n"
    return text


def override_path() -> str:
    return os.path.join(root_dir(), "docker-compose.override.yml")


def apply_volume_config(manifest: dict, volume_values: dict) -> None:
    """Write plugin volume mounts + env vars (OldCode convention).

    * ``.env`` gets ``VAR=host_path`` (seeded from ``.env.example`` when missing).
    * ``docker-compose.override.yml`` mounts ``${VAR:-default}:container`` and
      sets ``VAR: container`` — core ``docker-compose.yml`` is never touched.
    * Rewrites are idempotent per plugin (``# [id]`` tagged lines).
    """
    plugin_id = manifest.get("id", "plugin")
    volumes = [v for v in manifest.get("volumes", []) if isinstance(v, dict) and v.get("env_var")]

    env_updates = {}
    for v in volumes:
        host_path = ((volume_values or {}).get(v["env_var"]) or v.get("host_path") or "").strip()
        if host_path:
            env_updates[v["env_var"]] = host_path
    if env_updates:
        update_env_file(env_updates)

    path = override_path()
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except FileNotFoundError:
        text = OVERRIDE_SKELETON
    text = _ensure_markers(text)

    vol_lines = [
        f"      - ${{{v['env_var']}:-{v.get('host_path', '')}}}:{v.get('container_path', f'/data/{plugin_id}')}"
        for v in volumes
    ]
    env_lines = [f"      {v['env_var']}: {v.get('container_path', f'/data/{plugin_id}')}" for v in volumes]

    # Single pass: drop this plugin's old tagged lines, then insert the fresh
    # volume + env blocks after their markers (two separate splices would eat
    # each other's tagged lines).
    tag = f"# [{plugin_id}]"
    out = []
    for line in text.splitlines(keepends=True):
        if tag in line:
            continue
        out.append(line)
        if line.rstrip("\n") == VOL_START:
            out.extend(f"{b}  {tag}\n" for b in vol_lines)
        elif line.rstrip("\n") == ENV_START:
            out.extend(f"{b}  {tag}\n" for b in env_lines)
    with open(path, "w", encoding="utf-8") as f:
        f.write("".join(out))


def remove_volume_config(plugin_id: str) -> None:
    """Drop a plugin's tagged lines from the compose override."""
    path = override_path()
    if not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.readlines()
        tag = f"# [{plugin_id}]"
        with open(path, "w", encoding="utf-8") as f:
            f.writelines([l for l in lines if tag not in l])
    except Exception as e:
        logger.error("Removing plugin compose config: %s", e)


def remove_env_keys(keys: list) -> None:
    """Drop exact keys from .env (plugin uninstall)."""
    keys = {k for k in keys if k}
    if not keys:
        return
    path = os.path.join(root_dir(), ".env")
    if not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.readlines()
        out = []
        for line in lines:
            s = line.strip()
            if s and not s.startswith("#") and "=" in s and s.split("=", 1)[0].strip() in keys:
                continue
            out.append(line)
        with open(path, "w", encoding="utf-8") as f:
            f.writelines(out)
    except Exception as e:
        logger.error("Removing plugin env keys: %s", e)


def update_env_file(updates: dict) -> None:
    if not updates:
        return
    path = os.path.join(root_dir(), ".env")
    lines: list = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            lines = f.readlines()
    else:
        # Seed structure from the example so plugin keys land in a sane file.
        example = os.path.join(root_dir(), ".env.example")
        if os.path.exists(example):
            with open(example, encoding="utf-8") as f:
                lines = f.readlines()
    keys = set(updates)
    out = []
    for line in lines:
        s = line.strip()
        if s and not s.startswith("#") and "=" in s and s.split("=", 1)[0].strip() in keys:
            continue
        out.append(line)
    for k, v in updates.items():
        out.append(f"{k}={v}\n")
    with open(path, "w", encoding="utf-8") as f:
        f.writelines(out)


def fetch_store_catalog() -> dict:
    """Fetch the hub catalog (plugins + core versions for update badges)."""
    try:
        r = requests.get(HUB_URL, timeout=15)
        if r.ok:
            data = r.json()
            if isinstance(data, dict) and isinstance(data.get("plugins"), list):
                return data
    except Exception as e:
        logger.warning("Store catalog fetch failed: %s", e)
    return {"plugins": []}

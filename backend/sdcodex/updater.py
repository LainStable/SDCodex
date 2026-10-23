"""Git-based core/plugin updates and plugin installs.

Slim port of OldCode plugin_manager.py flows, adapted to the new layout:

* core updates: ``git pull`` the repo (works locally and in Docker, where
  the repo is mounted rw at /app).
* plugin updates/installs: git clone/pull into the plugins dir.
* plugin ``requirements.txt`` files merge into ``plugin-requirements.txt``
  (tracked-ignored), separate from core ``requirements.txt``.
* Docker plugin volumes/env land in ``.env`` + ``docker-compose.override.yml``
  (both git-ignored, so pulls never clobber them).
"""

import base64
import codecs
import functools
import json
import logging
import os
import queue
import re
import shutil
import subprocess
import threading
import time

import requests

logger = logging.getLogger(__name__)

HUB_URL = os.environ.get(
    "PLUGIN_HUB_URL",
    "https://raw.githubusercontent.com/LainStable/SDCodex-Plugin-Hub/main/plugins.json",
)
HUB_API_URL = os.environ.get("PLUGIN_HUB_API_URL", "").strip()

# Short-lived network caches: /api/plugins and /api/updates/check used to run
# `git ls-remote` + a hub fetch on every request, stalling the UI when GitHub
# was slow or offline.
_NET_CACHE: dict = {}
_NET_CACHE_LOCK = threading.Lock()


def _cached(key: str, ttl: float, producer):
    now = time.time()
    with _NET_CACHE_LOCK:
        hit = _NET_CACHE.get(key)
        if hit and hit[0] > now:
            return hit[1]
    value = producer()
    with _NET_CACHE_LOCK:
        _NET_CACHE[key] = (now + ttl, value)
    return value


_REPO_PART_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98})$")
_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")

# `git pull`/clone in the same working tree cannot run concurrently: the loser
# hits index.lock and can leave a half-updated plugin. Serialize these
# operations instead of letting two admin clicks race.
_OP_LOCK = threading.Lock()


def _serialized(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        if not _OP_LOCK.acquire(blocking=False):
            return False, "Another update or install is already running."
        try:
            return fn(*args, **kwargs)
        finally:
            _OP_LOCK.release()

    return wrapper


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


def _https_url(url: str) -> str:
    """Map a GitHub SSH URL to its HTTPS equivalent; other URLs pass through.

    Minimal production images ship without an SSH client or keys, so an SSH
    remote cannot be the default transport.
    """
    value = (url or "").strip()
    match = re.match(r"^git@github\.com:([^/]+/[^/]+?)(?:\.git)?$", value)
    if not match:
        match = re.match(r"^ssh://git@github\.com/([^/]+/[^/]+?)(?:\.git)?$", value)
    if not match:
        return value
    return f"https://github.com/{match.group(1)}.git"


def _https_github_remote(path: str, remote: str) -> str:
    """Return an HTTPS equivalent for a GitHub SSH remote, if one exists.

    Empty string means the remote is already HTTPS (or not a GitHub SSH URL),
    i.e. there is nothing to prefer.
    """
    try:
        r = _git(["remote", "get-url", remote], cwd=path)
        if r.returncode != 0:
            return ""
        url = r.stdout.strip()
        https = _https_url(url)
        return https if https != url else ""
    except Exception:
        return ""


def _current_branch(path: str) -> str:
    """Branch checked out in a plugin clone ('' for detached HEAD)."""
    try:
        r = _git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=path)
        name = (r.stdout or "").strip()
        return name if r.returncode == 0 and name and name != "HEAD" else ""
    except Exception:
        return ""


def remote_rev(repo_path_or_url: str, timeout: int = 20) -> str:
    """Remote sha of the tracked ref via the local remote (no tokens needed).

    Beta plugins are pinned to a non-default branch, so compare against that
    branch's head instead of the repository's default HEAD.
    """
    try:
        if os.path.isdir(os.path.join(repo_path_or_url, ".git")):
            remote = _detect_remote(repo_path_or_url)
            # HTTPS first (see _https_url): SSH remotes are unreachable in a
            # minimal image, which used to hide every available update.
            target = _https_github_remote(repo_path_or_url, remote) or remote
            branch = _current_branch(repo_path_or_url)
            ref = f"refs/heads/{branch}" if branch else "HEAD"
            r = _git(["ls-remote", target, ref], cwd=repo_path_or_url, timeout=timeout)
        else:
            r = _git(["ls-remote", _https_url(repo_path_or_url), "HEAD"], cwd=root_dir(), timeout=timeout)
        if r.returncode != 0:
            return ""
        return r.stdout.split()[0]
    except Exception:
        return ""


def is_clean(path: str) -> bool:
    # Untracked files (runtime downloads, user files) must not block updates;
    # only tracked modifications do. An upstream file colliding with an
    # untracked local one still fails the pull with its own clear error.
    try:
        r = _git(["status", "--porcelain", "--untracked-files=no"], cwd=path)
        return r.returncode == 0 and not r.stdout.strip()
    except Exception:
        return False


def _dirty_files(path: str, limit: int = 5) -> str:
    try:
        r = _git(["status", "--porcelain", "--untracked-files=no"], cwd=path)
        if r.returncode != 0 or not r.stdout.strip():
            return ""
        lines = [l.strip() for l in r.stdout.splitlines() if l.strip()][:limit]
        return ", ".join(lines)
    except Exception:
        return ""


def _current_branch(path: str) -> str:
    try:
        r = _git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=path)
        branch = (r.stdout or "").strip()
        return "" if branch in ("", "HEAD") else branch
    except Exception:
        return ""


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


def _update_log(message: str, *, reset: bool = False) -> None:
    """Append update progress to the log polled by the Plugin Hub UI."""
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}"
    try:
        with open(os.path.join(root_dir(), ".rebuild.log"), "w" if reset else "a", encoding="utf-8") as f:
            f.write(line + "\n")
            f.flush()
    except OSError:
        logger.exception("Could not write core update progress log")


def _git_pull_with_progress(args: list[str], cwd: str, timeout: int = 300) -> subprocess.CompletedProcess:
    """Run git pull while writing each output line for the progress UI."""
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    proc = subprocess.Popen(
        ["git", "-c", "safe.directory=*", *args],
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=env,
    )
    output: queue.Queue[str | None] = queue.Queue()

    def read_output() -> None:
        assert proc.stdout is not None
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        pending = ""
        while chunk := proc.stdout.read1(4096):
            pending += decoder.decode(chunk)
            lines = re.split(r"[\r\n]", pending)
            for line in lines[:-1]:
                output.put(line)
            pending = lines[-1]
        pending += decoder.decode(b"", final=True)
        if pending:
            output.put(pending)
        output.put(None)

    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()
    captured = []
    started = time.monotonic()
    finished_reading = False
    while not finished_reading or proc.poll() is None:
        if time.monotonic() - started > timeout:
            proc.kill()
            proc.wait()
            _update_log("git pull timed out")
            raise subprocess.TimeoutExpired(["git", *args], timeout)
        try:
            line = output.get(timeout=0.1)
        except queue.Empty:
            continue
        if line is None:
            finished_reading = True
        elif line:
            captured.append(line)
            _update_log(f"git: {line[:500]}")
    reader.join(timeout=1)
    return subprocess.CompletedProcess(args, proc.returncode or 0, "\n".join(captured), "")


# ------------------------------------------------------------------ core ---

def _hub_api_endpoint() -> str:
    """GitHub contents API URL for the hub catalog, or "" for custom hubs."""
    if HUB_API_URL:
        return HUB_API_URL
    prefix = "https://raw.githubusercontent.com/"
    if not HUB_URL.startswith(prefix):
        return ""
    parts = HUB_URL[len(prefix) :].split("/", 3)
    if len(parts) != 4 or not all(parts):
        return ""
    owner, repo, ref, path = parts
    return f"https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={ref}"


def _fetch_hub_catalog(timeout: int = 15) -> dict:
    """Fetch the hub catalog, preferring the uncached GitHub contents API.

    raw.githubusercontent.com serves a 5-minute CDN cache, so a freshly
    published core version stayed invisible to the update checker (and the
    toast/badge) until the cache expired. The contents API is immediate; raw
    remains the fallback for self-hosted or offline setups.
    """
    api = _hub_api_endpoint()
    if api:
        headers = {"Accept": "application/vnd.github+json"}
        token = _github_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            r = requests.get(api, headers=headers, timeout=timeout)
            if r.ok:
                payload = r.json()
                content = payload.get("content") if isinstance(payload, dict) else None
                if payload.get("encoding") == "base64" and content:
                    data = json.loads(base64.b64decode(content))
                    if isinstance(data, dict) and isinstance(data.get("plugins"), list):
                        return data
        except Exception as e:
            logger.warning("Hub API fetch failed: %s", e)
    try:
        r = requests.get(HUB_URL, timeout=timeout)
        if r.ok:
            data = r.json()
            if isinstance(data, dict) and isinstance(data.get("plugins"), list):
                return data
    except Exception as e:
        logger.warning("Store catalog fetch failed: %s", e)
    return {}


def check_core() -> dict:
    """Compare the local VERSION file against the hub's core version.

    The hub (plugins.json `core.version`, bumped every core push) is the
    source of truth — no git/ssh needed inside containers.
    """
    local = local_core_version()
    remote = ""
    try:
        data = _fetch_hub_catalog()
        remote = ((data.get("core") or {}).get("version") or "").strip()
    except Exception as e:
        logger.warning("Core update check failed: %s", e)
    return {
        "local_version": local,
        "remote_version": remote,
        "has_update": bool(local and remote and _parse_version(remote) > _parse_version(local)),
    }


@_serialized
def update_core() -> tuple[bool, str]:
    root = root_dir()
    _update_log("Core update requested", reset=True)
    if not os.path.isdir(os.path.join(root, ".git")):
        _update_log("Update failed: not a git checkout")
        return False, "Not a git checkout — cannot self-update."
    if not is_clean(root):
        dirty = _dirty_files(root)
        msg = "Working tree has local changes — commit or stash first."
        if dirty:
            msg += f" Dirty: {dirty}"
        _update_log(f"Update failed: {msg}")
        return False, msg
    remote = _detect_remote(root)
    # Pull the checked-out branch explicitly: `git pull --ff-only <remote>`
    # alone merges the *upstream* ref, which may point elsewhere (or
    # nowhere), failing or reporting "up to date" while the hub shows newer.
    branch = _current_branch(root)
    if not branch:
        _update_log("Update failed: detached HEAD")
        return False, "Detached HEAD — check out a branch (e.g. main) to self-update."
    # HTTPS first, then the configured remote. Production images have no SSH
    # client, so an SSH remote only ever failed here and then retried over
    # HTTPS; the fallback stays for private repos that authenticate by key.
    https_remote = _https_github_remote(root, remote)
    target = https_remote or remote
    try:
        pull_args = ["pull", "--ff-only", target, branch]
        _update_log(f"Running git pull --ff-only {target} {branch}")
        r = _git_pull_with_progress(pull_args, cwd=root)
        if r.returncode != 0 and https_remote:
            _update_log(f"HTTPS pull failed; retrying over the configured remote {remote}")
            r = _git_pull_with_progress(["pull", "--ff-only", remote, branch], cwd=root)
        if r.returncode != 0:
            error = (r.stderr or r.stdout).strip()[:500]
            _update_log(f"Git pull failed: {error}")
            return False, error
        out = (r.stdout or "Already up to date.").strip()[:500]
        core_changed = "already up to date" not in out.lower()
        _update_log(
            "Git pull complete"
            if core_changed
            else "Git pull complete: core already up to date"
        )

        # One Update click also refreshes every installed plugin, so the
        # rebuild/restart that follows loads core + plugin changes together.
        updated, failed, plugins_changed = update_installed_plugins()

        summary = out
        if plugins_changed:
            summary += f" · {updated} plugin(s) updated"
        if failed:
            summary += f" · {len(failed)} plugin(s) skipped"

        if core_changed or plugins_changed:
            from . import rebuilder as rebuilder_mod

            rebuilder_mod.mark_rebuild(
                "core and plugin update" if plugins_changed else "core update"
            )
            _update_log("Git pull complete; preparing application rebuild/restart")
        else:
            _update_log("Everything already up to date; no rebuild required")
        return True, summary
    except Exception as e:
        _update_log(f"Core update failed: {e}")
        return False, str(e)


# --------------------------------------------------------------- plugins ---

def split_repo_ref(url: str) -> tuple[str, str]:
    """Split ``https://github.com/owner/repo#branch`` into (url, branch).

    Hub entries for beta plugins point at a non-default branch; the fragment is
    stripped before URL validation so the branch never reaches git as an
    argument.
    """
    value = (url or "").strip()
    if "#" not in value:
        return value, ""
    base, _, branch = value.partition("#")
    branch = branch.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,120}", branch or ""):
        return value, ""
    if ".." in branch or branch.endswith("/"):
        return value, ""
    return base.strip(), branch


def normalize_github_url(url: str) -> tuple[str, str]:
    """Return (owner/repo short name, canonical https url).

    Only plain GitHub repositories are accepted. Anything containing shell
    metacharacters, traversal segments or a non-GitHub transport is rejected so
    a crafted install URL cannot become a git argument (`--upload-pack=…`) or
    write outside the plugins directory.
    """
    value = (url or "").strip().rstrip("/")
    match = re.match(
        r"^(?:https?://)?(?:www\.)?github\.com/([^/\s]+)/([^/\s]+?)(?:\.git)?/?$",
        value,
        re.IGNORECASE,
    )
    if match:
        owner, repo = match.group(1), match.group(2)
    else:
        match = re.fullmatch(r"([^/\s]+)/([^/\s]+?)(?:\.git)?", value)
        if not match:
            return "", ""
        owner, repo = match.group(1), match.group(2)
    if not _REPO_PART_RE.match(owner) or not _REPO_PART_RE.match(repo):
        return "", ""
    short = f"{owner}/{repo}"
    return short, f"https://github.com/{short}"


def safe_plugin_dirname(repo_name: str) -> str:
    """Filesystem-safe plugin folder name (no traversal / leading dots)."""
    name = re.sub(r"[^A-Za-z0-9._-]", "-", repo_name or "").strip(".-")
    name = name.lstrip(".")
    return (name[:100] or "plugin").lower()


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
        nav_items = mf.get("nav_items", []) if isinstance(mf.get("nav_items"), list) else []
        entry_page = mf.get("entry_page", "")
        if not entry_page and not nav_items:
            # Page-only plugins (nav_items cleared so the core sidebar stays
            # clean) still need a landing page for the plugin space.
            try:
                pages = sorted(
                    f[:-5]
                    for f in os.listdir(os.path.join(p, "pages"))
                    if f.endswith(".html") and f != "settings.html" and not f.startswith("settings-")
                )
            except OSError:
                pages = []
            if pages:
                entry_page = pages[0]
        out.append(
            {
                "id": mf.get("id", item),
                "name": mf.get("name", item),
                "version": mf.get("version", ""),
                "description": mf.get("description", ""),
                "repository": mf.get("repository", ""),
                "icon": mf.get("icon", ""),
                "entry_page": entry_page,
                "nav_items": nav_items,
                "settings": mf.get("settings", []) if isinstance(mf.get("settings"), list) else [],
                "task_status": mf.get("task_status") if isinstance(mf.get("task_status"), dict) else None,
                "assistant_actions": mf.get("assistant_actions") if isinstance(mf.get("assistant_actions"), list) else [],
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
            import types
            import sys as _sys

            if p["path"] not in _sys.path:
                _sys.path.insert(0, p["path"])
            # Plugin repos commonly name their entrypoint module ``plugin``.
            # Importing that generic name globally made every plugin after the
            # first reuse the first plugin's cached module, so its blueprints
            # were never registered. Give each plugin a private package while
            # preserving normal relative imports within that repo.
            package_name = "_sdcodex_plugin_" + re.sub(r"[^A-Za-z0-9_]", "_", p["id"])
            if package_name not in _sys.modules:
                package = types.ModuleType(package_name)
                package.__path__ = [p["path"]]
                package.__package__ = package_name
                _sys.modules[package_name] = package
            mod = importlib.import_module(f"{package_name}.{mod_name}")
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
    """Compare each git-backed plugin against its remote HEAD (cached 60 s).

    Probes run concurrently with a short per-repo timeout: the old serial
    20 s-each walk froze ``/api/plugins`` for minutes on a slow restart, which
    looked like the plugins had disappeared.
    """

    def _probe(p: dict):
        try:
            remote = remote_rev(p["path"], timeout=8)
        except Exception:
            return None
        if remote and p["local_sha"] and remote != p["local_sha"]:
            return {**p, "remote_sha": remote, "has_update": True}
        return None

    def _check():
        targets = [
            p
            for p in list_installed()
            if os.path.isdir(os.path.join(p["path"], ".git"))
        ]
        if not targets:
            return []
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=min(8, len(targets))) as pool:
            return [r for r in pool.map(_probe, targets) if r]

    return _cached("plugin_updates", 60, _check)


_UPDATE_PROBE_LOCK = threading.Lock()
_UPDATE_PROBE_RUNNING = False


def start_plugin_probe() -> bool:
    """Refresh the plugin-update cache in the background (never blocks a request).

    Returns True when a probe was started, False when one is already running.
    """
    global _UPDATE_PROBE_RUNNING
    with _UPDATE_PROBE_LOCK:
        if _UPDATE_PROBE_RUNNING:
            return False
        _UPDATE_PROBE_RUNNING = True

    def _run():
        global _UPDATE_PROBE_RUNNING
        try:
            check_plugin_updates()
        except Exception:
            logger.warning("Plugin update probe failed", exc_info=True)
        finally:
            with _UPDATE_PROBE_LOCK:
                _UPDATE_PROBE_RUNNING = False

    threading.Thread(target=_run, name="plugin-update-probe", daemon=True).start()
    return True


def cached_plugin_updates() -> tuple[list, bool]:
    """Plugin updates without network I/O.

    Returns ``(updates, checked)``. The first call after boot (or after the
    60 s cache expires) returns the last known list and starts a background
    probe, so callers such as ``/api/plugins`` answer immediately and the UI
    can retry until ``checked`` flips true.
    """
    now = time.time()
    with _NET_CACHE_LOCK:
        hit = _NET_CACHE.get("plugin_updates")
        checked = bool(hit and hit[0] > now)
        value = list(hit[1]) if hit else []
    if not checked:
        start_plugin_probe()
    return value, checked


@_serialized
def update_plugin(plugin_id: str) -> tuple[bool, str]:
    return _update_plugin_unlocked(plugin_id)


def _update_plugin_unlocked(plugin_id: str) -> tuple[bool, str]:
    """Pull one plugin; caller must already hold ``_OP_LOCK``."""
    target = plugin_path(plugin_id)
    if not target or not os.path.isdir(os.path.join(target, ".git")):
        return False, "Not a git checkout — reinstall the plugin."
    if not is_clean(target):
        dirty = _dirty_files(target)
        msg = "Plugin has local changes — reinstall instead."
        if dirty:
            msg += f" Dirty: {dirty}"
        return False, msg
    try:
        branch = _current_branch(target)
        remote = _detect_remote(target)
        # HTTPS first, configured remote as the fallback (see update_core).
        https_remote = _https_github_remote(target, remote)
        target_remote = https_remote or remote
        args = ["pull", "--ff-only", target_remote] + ([branch] if branch else [])
        r = _git(args, cwd=target)
        if r.returncode != 0 and https_remote:
            r = _git(["pull", "--ff-only", remote] + ([branch] if branch else []), cwd=target)
        if r.returncode != 0:
            return False, (r.stderr or r.stdout).strip()[:500]
        _NET_CACHE.pop("plugin_updates", None)
        return True, (r.stdout or "Already up to date.").strip()[:500]
    except Exception as e:
        return False, str(e)


def _log_first_line(text: str, limit: int = 180) -> str:
    lines = (text or "").strip().splitlines()
    return lines[0][:limit] if lines else ""


def update_installed_plugins() -> tuple[int, list[str], bool]:
    """Pull every installed git-backed plugin (caller holds ``_OP_LOCK``).

    Returns ``(updated_count, failed_ids, changed)``. One plugin's local
    changes or broken remote must never abort the others.
    """
    plugins = [
        p for p in list_installed()
        if os.path.isdir(os.path.join(p["path"], ".git"))
    ]
    _update_log(f"Plugin updates: checking {len(plugins)} installed plugin(s)")
    updated = 0
    failed: list[str] = []
    changed = False
    for plugin in plugins:
        ok, output = _update_plugin_unlocked(plugin["id"])
        if not ok:
            failed.append(plugin["id"])
            _update_log(
                f"Plugin update skipped: {plugin['name']} ({plugin['id']}): "
                f"{_log_first_line(output)}"
            )
            continue
        if "already up to date" in output.lower():
            _update_log(f"Plugin up to date: {plugin['name']}")
        else:
            updated += 1
            changed = True
            _update_log(f"Plugin updated: {plugin['name']} ({plugin['id']})")
    _update_log(
        f"Plugin updates complete: {updated} updated, "
        f"{len(plugins)} checked, {len(failed)} skipped"
    )
    _NET_CACHE.pop("plugin_updates", None)
    return updated, failed, changed


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


@_serialized
def install_plugin(
    repo_url: str,
    volume_paths: dict | None = None,
    install_mode: str | None = None,
    plugin_id: str | None = None,
) -> tuple[bool, str | dict]:
    """Clone a plugin, merge requirements, configure volumes. Returns manifest.

    ``repo_url`` may carry a ``#branch`` suffix for beta channels. ``plugin_id``
    selects the install directory (so the same repository can be installed on
    several branches side by side) and is validated against the manifest.
    """
    repo_url, branch = split_repo_ref(repo_url)
    short, canonical = normalize_github_url(repo_url)
    if not short or not canonical:
        return False, "Only GitHub repository URLs (owner/repo) are supported."
    repo_name = short.split("/")[-1]
    # Only channel installs (``#branch``) take the plugin id as their folder:
    # stable plugins keep their historical repo-named directory so existing
    # installs are never duplicated (two dirs with the same manifest id would
    # both register the same routes).
    wanted_id = safe_plugin_dirname(plugin_id) if (plugin_id and branch) else ""
    target = os.path.join(plugins_dir(), wanted_id or safe_plugin_dirname(repo_name))
    token = _github_token()
    clone_args = ["clone", "--single-branch"] + (["--branch", branch] if branch else []) + [canonical, target]

    if os.path.isdir(os.path.join(target, ".git")):
        # Keep an existing checkout on the requested channel.
        if branch:
            current = _git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=target)
            if current.returncode == 0 and current.stdout.strip() != branch:
                _git(["fetch", "origin", branch], cwd=target)
                fetch_head = _git(["rev-parse", f"origin/{branch}"], cwd=target)
                if fetch_head.returncode == 0:
                    _git(["checkout", "-B", branch, f"origin/{branch}"], cwd=target)
        r = _git(["pull", "--ff-only"], cwd=target)
        if r.returncode != 0:
            return False, f"Update failed: {(r.stderr or r.stdout).strip()[:300]}"
    else:
        if os.path.exists(target):
            shutil.rmtree(target)
        # Anonymous first (public repos); token only as fallback for private
        # repos — a stale/invalid token must never break public clones.
        r = _git(clone_args, cwd=root_dir())
        if r.returncode != 0 and token:
            from urllib.parse import quote

            clone_url = f"https://x-access-token:{quote(token, safe='')}@github.com/{short}.git"
            r = _git(["clone", "--single-branch"] + (["--branch", branch] if branch else []) + [clone_url, target], cwd=root_dir())
        if r.returncode != 0 and not branch:
            r = _git(["clone", "-b", "master", canonical, target], cwd=root_dir())
        if r.returncode != 0:
            msg = f"Clone failed: {(r.stderr or r.stdout).strip()[:300]}"
            if not token:
                msg += " Private repo? Set GITHUB_TOKEN."
            return False, msg

    manifest = read_manifest(target) or {"id": repo_name.lower(), "name": repo_name}
    actual_id = manifest.get("id", repo_name.lower())
    if wanted_id and actual_id != plugin_id:
        # A branch that does not declare the hub id would register other routes
        # (or collide with the stable plugin); refuse instead of half-installing.
        shutil.rmtree(target, ignore_errors=True)
        return False, (
            f"Repository branch '{branch or 'default'}' declares plugin id "
            f"'{actual_id}', expected '{plugin_id}'."
        )
    plugin_id = actual_id
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
    if install_mode is None:
        from . import rebuilder as rebuilder_mod

        install_mode = rebuilder_mod.configured_install_mode()
    if install_mode == "docker":
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

    volumes = manifest.get("volumes", []) if install_mode == "docker" else []
    needed = []
    for v in volumes:
        if not isinstance(v, dict) or not v.get("env_var"):
            continue
        vv = dict(v)
        vv["host_path"] = volume_values.get(vv["env_var"], vv.get("host_path", ""))
        needed.append(vv)
    from . import rebuilder as rebuilder_mod

    rebuilder_mod.mark_rebuild(f"install {plugin_id}")
    _NET_CACHE.pop("plugin_updates", None)
    return True, {"id": plugin_id, "name": manifest.get("name", plugin_id), "volumes": needed}


@_serialized
def uninstall_plugin(plugin_id: str, install_mode: str | None = None) -> tuple[bool, str]:
    target = plugin_path(plugin_id)
    if not target or not os.path.isdir(target):
        return False, "Not installed."
    manifest = read_manifest(target) or {}
    if install_mode is None:
        from . import rebuilder as rebuilder_mod

        install_mode = rebuilder_mod.configured_install_mode()
    try:
        if install_mode == "docker":
            remove_volume_config(plugin_id)
            remove_env_keys(
                [v.get("env_var") for v in manifest.get("volumes", []) if isinstance(v, dict) and v.get("env_var")]
            )
        shutil.rmtree(target)
        from . import rebuilder as rebuilder_mod

        rebuilder_mod.mark_rebuild(f"uninstall {plugin_id}")
    except Exception as e:
        return False, str(e)
    _NET_CACHE.pop("plugin_updates", None)
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
    return True, f"Plugin '{plugin_id}' removed. Restart/rebuild to apply the change."


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
    volumes = []
    for volume in manifest.get("volumes", []):
        if not isinstance(volume, dict):
            continue
        env_var = str(volume.get("env_var") or "").strip()
        container_path = str(volume.get("container_path") or "").strip()
        if not _ENV_KEY_RE.match(env_var) or not container_path.startswith("/"):
            logger.warning("Ignoring invalid volume entry for %s", plugin_id)
            continue
        if any(ch in container_path for ch in "\r\n"):
            continue
        volumes.append({**volume, "env_var": env_var, "container_path": container_path})

    env_updates = {}
    for v in volumes:
        host_path = ((volume_values or {}).get(v["env_var"]) or v.get("host_path") or "").strip()
        if host_path and not any(ch in host_path for ch in "\r\n"):
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
    clean = {}
    for key, value in (updates or {}).items():
        key = str(key).strip()
        value = str(value or "").strip()
        if not _ENV_KEY_RE.match(key):
            logger.warning("Ignoring invalid env key %r", key[:80])
            continue
        if any(ch in value for ch in "\r\n\x00"):
            logger.warning("Ignoring multi-line value for env key %s", key)
            continue
        clean[key] = value
    if not clean:
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
    keys = set(clean)
    out = []
    for line in lines:
        s = line.strip()
        if s and not s.startswith("#") and "=" in s and s.split("=", 1)[0].strip() in keys:
            continue
        out.append(line)
    for k, v in clean.items():
        out.append(f"{k}={v}\n")
    with open(path, "w", encoding="utf-8") as f:
        f.writelines(out)


def fetch_store_catalog() -> dict:
    """Fetch the hub catalog (plugins + core versions for update badges)."""

    def _fetch():
        return _fetch_hub_catalog(timeout=10) or {"plugins": []}

    return _cached("store_catalog", 120, _fetch)

"""Rebuild-required flag + mode-aware application restart.

Plugin installs/uninstalls/volume changes (and core updates, which bake a new
frontend into the image) need a Docker rebuild or Local backend restart to take
effect. This module:

* tracks the need in a ``.rebuild-required`` marker file (git-ignored),
* rebuilds via the Docker SDK over the mounted socket: image build from the
  mounted repo, then self-replace with compose-merged mounts/env,
* restarts the backend process in Local mode (repo runs live from disk).
"""

import logging
import os
import re
import socket
import sys
import threading
import time

logger = logging.getLogger(__name__)

FLAG_NAME = ".rebuild-required"
IMAGE_TAG = "sdcodex:latest"


def root_dir() -> str:
    return os.environ.get("SDCODEX_ROOT") or os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..")
    )


def flag_path() -> str:
    return os.path.join(root_dir(), FLAG_NAME)


def needs_rebuild() -> bool:
    return os.path.exists(flag_path())


def mark_rebuild(reason: str = "") -> None:
    try:
        with open(flag_path(), "w", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {reason}\n")
    except Exception as e:
        logger.error("Writing rebuild flag: %s", e)


def clear_rebuild() -> None:
    try:
        if os.path.exists(flag_path()):
            os.remove(flag_path())
    except Exception as e:
        logger.error("Clearing rebuild flag: %s", e)


def in_docker() -> bool:
    return os.path.exists("/.dockerenv")


def socket_available() -> bool:
    return os.path.exists("/var/run/docker.sock")


def runtime_mode() -> str:
    return "docker" if in_docker() else "local"


def configured_install_mode() -> str:
    from . import db
    from .models import Setting

    row = db.session.get(Setting, "install_mode")
    if row and row.value in {"docker", "local"}:
        return row.value
    return runtime_mode()


def install_mode_status() -> dict:
    configured = configured_install_mode()
    runtime = runtime_mode()
    return {
        "mode": configured,
        "runtime_mode": runtime,
        "matches_runtime": configured == runtime,
    }


def _rebuild_capability(configured: str, runtime: str) -> dict:
    if configured != runtime:
        return {
            "can_rebuild": False,
            "mode": "mismatch",
            "install_mode": configured,
            "runtime_mode": runtime,
        }
    if configured == "docker":
        if socket_available():
            return {
                "can_rebuild": True,
                "mode": "docker",
                "install_mode": configured,
                "runtime_mode": runtime,
            }
        return {
            "can_rebuild": False,
            "mode": "docker-nosocket",
            "install_mode": configured,
            "runtime_mode": runtime,
        }
    return {
        "can_rebuild": True,
        "mode": "local",
        "install_mode": configured,
        "runtime_mode": runtime,
    }


# ------------------------------------------------- compose merge --------

# Innermost-first pattern: neither the var name nor the default may contain
# `$`, `{` or `}`. Repeated substitution (see _interp) therefore resolves
# nested compose defaults inside-out, e.g.
# `${SDCODEX_PORT:-${PORT:-5000}}` with PORT=8000 -> `${SDCODEX_PORT:-8000}`
# -> `8000`. (A single-pass outer-first regex mis-parses the nesting and
# leaves a stray `}`, which previously broke every rebuild port mapping.)
_INNER_RE = re.compile(r"\$\{([^${}:]+)(?::-([^${}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)")


def _interp_once(value: str, env: dict) -> str:
    def sub(m: re.Match) -> str:
        if m.group(3) is not None:
            return env.get(m.group(3), "")
        var, default = m.group(1), m.group(2)
        if var in env and env[var] != "":
            return env[var]
        return default if default is not None else ""

    return _INNER_RE.sub(sub, value)


def _interp(value: str, env: dict) -> str:
    """Compose-style interpolation supporting nested `${VAR:-default}`."""
    prev, cur = None, value
    for _ in range(10):
        if prev == cur:
            break
        prev, cur = cur, _interp_once(cur, env)
    return cur


def _load_dotenv(root: str) -> dict:
    vals: dict = {}
    for name in (".env", "env"):
        p = os.path.join(root, name)
        if os.path.isfile(p):
            try:
                with open(p, encoding="utf-8") as f:
                    for line in f:
                        s = line.strip()
                        if s and not s.startswith("#") and "=" in s:
                            k, v = s.split("=", 1)
                            vals[k.strip()] = v.strip()
                break
            except Exception:
                pass
    return vals


def _load_service(root: str) -> dict:
    """Merge services.sdcodex from docker-compose.yml + override (+ .env)."""
    try:
        import yaml
    except ImportError:
        return {}
    env = dict(os.environ)
    env.update(_load_dotenv(root))
    if "PORT" in env and not env.get("SDCODEX_PORT"):
        env["SDCODEX_PORT"] = env["PORT"]
    # Compose defaults used by our core file.
    env.setdefault("SDCODEX_PORT", "5000")
    merged: dict = {}
    for fname in ("docker-compose.yml", "docker-compose.override.yml"):
        p = os.path.join(root, fname)
        if not os.path.isfile(p):
            continue
        try:
            with open(p, encoding="utf-8") as f:
                doc = yaml.safe_load(f) or {}
            svc = (doc.get("services") or {}).get("sdcodex") or {}
        except Exception as e:
            logger.error("Parsing %s: %s", fname, e)
            continue
        for key in ("image", "container_name", "restart", "ports", "volumes", "environment"):
            if key in svc and svc[key] is not None:
                if key in ("volumes", "ports") and key in merged:
                    merged[key] = list(merged[key]) + list(svc[key] or [])
                elif key == "environment":
                    merged[key] = _merge_env(merged.get(key), svc[key])
                else:
                    merged[key] = svc[key]
    out = dict(merged)
    out["volumes"] = [_interp(str(v), env) for v in merged.get("volumes", [])]
    out["ports"] = [_interp(str(v), env) for v in merged.get("ports", [])]
    out["environment"] = {k: _interp(str(v), env) for k, v in _env_dict(merged.get("environment")).items()}
    out["image"] = _interp(str(merged.get("image", IMAGE_TAG)), env) or IMAGE_TAG
    out["container_name"] = merged.get("container_name", "sdcodex")
    return out


def _env_dict(env) -> dict:
    if isinstance(env, dict):
        return dict(env)
    out = {}
    for item in env or []:
        s = str(item)
        if "=" in s:
            k, v = s.split("=", 1)
            out[k] = v
        else:
            out[s] = os.environ.get(s, "")
    return out


def _merge_env(a, b) -> dict:
    d = _env_dict(a)
    d.update(_env_dict(b))
    return d


def _split_bind(spec: str, project_host_dir: str):
    """Convert a Compose volume entry to (source, Docker SDK bind options).

    Relative host paths are compose-project-relative — resolved against the
    HOST project dir (own /app mount source), never the container's /app.
    """
    if isinstance(spec, dict):
        host = spec.get("source") or spec.get("src")
        cont = spec.get("target") or spec.get("dst") or spec.get("destination")
        if not host or not cont:
            return None
        host = str(host)
        if host.startswith("."):
            host = os.path.abspath(os.path.join(project_host_dir, host))
        mode = "ro" if spec.get("read_only") else "rw"
        return (host, {"bind": str(cont), "mode": mode})
    parts = spec.split(":")
    if len(parts) < 2:
        return None
    host, cont = parts[0], parts[1]
    mode = parts[2] if len(parts) > 2 else "rw"
    if host.startswith("."):
        host = os.path.abspath(os.path.join(project_host_dir, host))
    return (host, {"bind": cont, "mode": mode})


def _resolve_binds(volume_specs: list, project_host_dir: str) -> dict:
    """Resolve mounts with Compose's uniqueness rule: one mount per target.

    Compose overrides merge volume entries by container target, with later
    entries replacing earlier ones. Reproduce that behavior before calling
    Docker directly, which rejects duplicate target paths instead of merging
    them.
    """
    binds = {}
    source_by_target = {}
    for spec in volume_specs or []:
        parsed = _split_bind(spec, project_host_dir)
        if not isinstance(parsed, tuple):
            continue
        source, options = parsed
        target = options.get("bind")
        if not target:
            continue
        previous = source_by_target.get(target)
        if previous is not None:
            binds.pop(previous, None)
        binds[source] = options
        source_by_target[target] = source
    return binds


def _host_project_dir(client, me) -> str:
    """Host path of the compose project (source of our own /app mount)."""
    try:
        me.reload()
        for m in me.attrs.get("Mounts", []):
            if m.get("Destination") == "/app":
                src = m.get("Source", "")
                if src and src != "/app":
                    return src
    except Exception as e:
        _rlog(f"project dir detect: {e}")
    return root_dir()


# ------------------------------------------------- rebuild --------------

def _docker_client():
    import docker

    return docker.DockerClient(base_url="unix:///var/run/docker.sock", timeout=1200)


def _rlog(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    logger.warning("rebuild: %s", msg)
    try:
        with open(os.path.join(root_dir(), ".rebuild.log"), "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def _wait_healthy(client, name: str, timeout_s: int = 420) -> bool:
    """Exec the backend healthcheck inside the new container until 200."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            c = client.containers.get(name)
            if c.status != "running":
                c.reload()
                if c.status != "running":
                    time.sleep(5)
                    continue
            rc, _ = c.exec_run(
                ["python", "-c",
                 "import urllib.request as u; u.urlopen('http://127.0.0.1:5000/api/health', timeout=5)"],
                demux=False,
            )
            if rc == 0:
                return True
        except Exception as e:
            _rlog(f"health wait: {e}")
        time.sleep(10)
    return False


def _container_networks(c) -> list:
    """Non-bridge networks a container is attached to."""
    try:
        c.reload()
        nets = (c.attrs.get("NetworkSettings", {}).get("Networks", {}) or {})
        return [n for n in nets if n != "bridge"]
    except Exception:
        return []


def _old_host_port(c, container_port: int = 5000):
    """Host port currently publishing container_port on c (or None).

    Ground truth for the swap: whatever the old self actually publishes is
    what the replacement must publish, regardless of how the port was
    configured (.env edit, shell env, manual `docker run -p`).
    """
    try:
        c.reload()
        ports = (c.attrs.get("NetworkSettings", {}) or {}).get("Ports", {}) or {}
        bindings = ports.get(f"{container_port}/tcp") or []
        if bindings and bindings[0].get("HostPort"):
            return int(bindings[0]["HostPort"])
        bindings = ((c.attrs.get("HostConfig", {}) or {}).get("PortBindings", {}) or {}).get(
            f"{container_port}/tcp"
        ) or []
        if bindings and bindings[0].get("HostPort"):
            return int(bindings[0]["HostPort"])
    except Exception as e:
        _rlog(f"old port detect: {e}")
    return None


def _rebuild_container() -> None:
    """Blue-green self-replace. Runs in a thread; progress in .rebuild.log.

    Build the image, start a -new sibling, wait for its healthcheck, then
    swap names and stop the old self. A failed build/start leaves the running
    container untouched — it can never strand the app anymore.
    """
    new_name = "sdcodex-new"
    try:
        client = _docker_client()
        root = root_dir()
        _rlog(f"image build started from {root}")
        for chunk in client.api.build(path=root, dockerfile="Dockerfile", tag=IMAGE_TAG, rm=True, decode=True):
            if isinstance(chunk, dict):
                if chunk.get("stream"):
                    _rlog("build: " + chunk["stream"].strip()[:160])
                if chunk.get("error"):
                    _rlog("BUILD ERROR: " + str(chunk["error"])[:500])
                    return
        cfg = _load_service(root)
        me_id = socket.gethostname()
        try:
            me = client.containers.get(me_id)
        except Exception:
            me = None
        proj = _host_project_dir(client, me) if me else root
        binds = _resolve_binds(cfg.get("volumes", []), proj)
        _rlog(f"binds: {sorted((v.get('bind'), k) for k, v in binds.items())}")
        # Fail fast: if project-dir detection fell back to the container's own
        # /app, relative binds would point inside the image and the sibling
        # would boot-loop (run.py missing). Never swap on a bad bind.
        if proj in ("", "/app"):
            _rlog("ABORT: could not resolve host project dir for relative binds")
            return
        # Swap inputs recorded BEFORE touching anything. Port precedence
        # lives in _resolve_ports: a post-start .env port change is honored
        # (compose wins); otherwise the old self's live binding wins (covers
        # shell env, manual `docker run -p`, interpolation failure); the
        # interpolated compose value is next; 5000 is the last resort.
        nets = _container_networks(me) if me else []
        live_port = _old_host_port(me) if me else None
        started_at = _container_started_at(me) if me else None
        cname = cfg.get("container_name", "sdcodex") or "sdcodex"
        dotenv_path = _dotenv_path(root)
        try:
            env_mtime = os.path.getmtime(dotenv_path) if dotenv_path else None
        except OSError:
            env_mtime = None
        wanted = _resolve_ports(cfg.get("ports", []), live_port,
                                dict(os.environ), _load_dotenv(root),
                                env_mtime, started_at)
        _rlog(f"ports: {wanted} nets: {nets}")
        # stale containers from a previous attempt (either name)
        for stale_name in (new_name, "sdcodex-old"):
            try:
                stale = client.containers.get(stale_name)
                stale.remove(force=True)
                _rlog(f"removed stale {stale_name}")
            except Exception:
                pass
        _rlog("creating sibling container (no ports — old self holds the port)")
        try:
            sibling = client.containers.run(
                IMAGE_TAG,
                name=new_name,
                detach=True,
                environment=cfg.get("environment", {}),
                volumes=binds,
                restart_policy={"Name": "no"},
            )
        except Exception as e:
            _rlog(f"sibling create failed — keeping current container: {e}")
            return
        # Join the old container's networks (e.g. sdcodex) so the sibling
        # lands on the same fabric before the swap.
        for net_name in nets:
            try:
                client.networks.get(net_name).connect(sibling)
                _rlog(f"sibling joined network {net_name}")
            except Exception as e:
                _rlog(f"network {net_name}: {e}")
        _rlog("sibling started, waiting for health")
        if not _wait_healthy(client, new_name):
            _rlog("sibling never healthy — keeping current container")
            try:
                bad = client.containers.get(new_name)
                bad.remove(force=True)
            except Exception:
                pass
            return
        if me is None:
            _rlog("old self not found — removing unswappable sibling")
            try:
                bad = client.containers.get(new_name)
                bad.remove(force=True)
            except Exception:
                pass
            return
        # The app thread cannot survive stopping its own container, so the
        # irreversible swap runs in a short-lived helper container
        # (sdcodex.swap_helper) that outlives us. Every rebuild used to die
        # right after "stopping old self" and the swap never ran.
        import json as _json

        try:
            old_id = me.id
        except Exception:
            old_id = me_id
        spec = {
            "old_id": old_id,
            "sibling": new_name,
            "cname": cname,
            "ports": wanted,
            "binds": binds,
            "environment": cfg.get("environment", {}),
            "networks": nets,
            "restart": cfg.get("restart", "unless-stopped") or "unless-stopped",
            "image": IMAGE_TAG,
        }
        helper_volumes = dict(binds)
        helper_volumes["/var/run/docker.sock"] = {"bind": "/var/run/docker.sock", "mode": "rw"}
        for stale_name in ("sdcodex-swap",):
            try:
                stale = client.containers.get(stale_name)
                stale.remove(force=True)
                _rlog(f"removed stale {stale_name}")
            except Exception:
                pass
        try:
            client.containers.run(
                IMAGE_TAG,
                # Override the image entrypoint rather than only passing a
                # command: entrypoint.sh used to `exec` the app and drop its
                # arguments, so the helper booted a second server and the
                # swap never happened (the app hung in "swap delegated").
                entrypoint=["python", "-m", "sdcodex.swap_helper"],
                name="sdcodex-swap",
                detach=True,
                auto_remove=True,
                environment={
                    "SWAP_SPEC_JSON": _json.dumps(spec),
                    "SWAP_LOG": "/app/.rebuild.log",
                    "PYTHONPATH": "/app/backend",
                },
                volumes=helper_volumes,
                restart_policy={"Name": "no"},
            )
        except Exception as e:
            _rlog(f"swap helper launch failed — keeping current container: {e}")
            return
        _rlog("swap delegated to helper sdcodex-swap — old self will go down shortly")
    except Exception:
        logger.error("Rebuild failed", exc_info=True)
        try:
            _rlog("rebuild exception — see backend log")
        except Exception:
            pass


def _port_map(ports: list) -> dict:
    out = {}
    for spec in ports:
        s = str(spec).strip()
        if not s:
            continue
        if ":" in s:
            host, cont = s.rsplit(":", 1)
            host, cont = host.strip(), cont.strip().split("/")[0]
            # Host may carry an interface prefix (127.0.0.1:8000) — the
            # trailing segment is the host port.
            if ":" in host:
                host = host.rsplit(":", 1)[1]
            out[f"{cont}/tcp"] = int(host)
        else:
            out[f"{s.split('/')[0]}/tcp"] = None
    return out


def _env_port(d: dict) -> int | None:
    """Effective host port from an env mapping (SDCODEX_PORT else PORT)."""
    for key in ("SDCODEX_PORT", "PORT"):
        v = (d.get(key) or "").strip() if isinstance(d, dict) else ""
        if v:
            try:
                return int(v)
            except ValueError:
                return None
    return None


def _dotenv_path(root: str) -> str | None:
    """Path of the dotenv file _load_dotenv would read, if any."""
    for name in (".env", "env"):
        p = os.path.join(root, name)
        if os.path.isfile(p):
            return p
    return None


def _parse_docker_ts(ts: str) -> float | None:
    """Parse a Docker RFC3339 timestamp (e.g. State.StartedAt) to epoch."""
    try:
        s = (ts or "").strip().replace("Z", "+00:00")
        if "." in s:
            head, rest = s.split(".", 1)
            frac, tz = rest[:-6], rest[-6:]
            s = f"{head}.{frac[:6]}{tz}"
        from datetime import datetime

        return datetime.fromisoformat(s).timestamp()
    except Exception:
        return None


def _container_started_at(c) -> float | None:
    """When container c was started (epoch), or None if undeterminable."""
    try:
        c.reload()
        ts = ((c.attrs.get("State", {}) or {}).get("StartedAt")) or ""
        if ts.startswith("0001-"):
            return None
        return _parse_docker_ts(ts)
    except Exception:
        return None


def _resolve_ports(port_specs: list, live_port: int | None,
                   startup_env: dict, file_env: dict,
                   env_mtime: float | None = None,
                   started_at: float | None = None) -> dict:
    """Pick the host-port mapping for the replacement container.

    Precedence:
    1. Compose-derived value, but ONLY on affirmative evidence of a
       post-start .env port change: the file's effective port differs from
       the startup effective port AND the dotenv file is newer than the
       container start. (A stale .env default must never drag a custom
       live port back to 5000, and a fresh .env edit must not be
       discarded in favor of the old live binding.)
    2. The old container's live binding — covers shell-env runs, manual
       `docker run -p`, and any interpolation failure.
    3. Compose-derived value, when valid.
    4. 5000.
    """
    try:
        wanted = _port_map(port_specs or [])
    except Exception as e:
        _rlog(f"port map parse failed ({e}) — falling back to live binding")
        wanted = {}
    compose_port = wanted.get("5000/tcp")
    file_port = _env_port(file_env)
    startup_port = _env_port(startup_env)
    file_changed = (
        compose_port is not None
        and file_port is not None
        and startup_port is not None
        and file_port != startup_port
        and env_mtime is not None
        and started_at is not None
        and env_mtime > started_at
    )
    if file_changed:
        _rlog(f"port change requested: {compose_port} (compose) over live {live_port}")
        return wanted
    if live_port is not None:
        if compose_port != live_port:
            _rlog(f"keeping live host port {live_port} for 5000/tcp")
        wanted["5000/tcp"] = live_port
    elif compose_port is None:
        wanted["5000/tcp"] = 5000
    return wanted


def _restart_process() -> None:
    """Bare metal: re-exec the backend (code runs live from disk)."""
    _rlog("local restart started; no Docker image build is required")
    time.sleep(2)
    clear_rebuild()
    run_py = os.path.join(root_dir(), "backend", "run.py")
    logger.warning("Restarting backend process")
    os.execv(sys.executable, [sys.executable, run_py])


def start_rebuild() -> tuple[bool, str]:
    """Kick off a rebuild/restart in the background. Returns ack immediately."""
    capability = rebuild_capability()
    if not capability["can_rebuild"]:
        if capability["mode"] == "mismatch":
            return False, (
                f"Configured {capability['install_mode']} mode does not match the "
                f"running {capability['runtime_mode']} process. Restart the app in "
                "the selected mode; this setting does not migrate installations."
            )
        return False, "Docker self-rebuild is unavailable; update or restart it from the host."
    if capability["mode"] == "docker":
        t = threading.Thread(target=_rebuild_container, daemon=True)
        t.start()
        return True, "Rebuild started — image build takes several minutes. The app will come back on its own."
    t = threading.Thread(target=_restart_process, daemon=True)
    t.start()
    return True, "Local backend restarting…"


def rebuild_capability() -> dict:
    return _rebuild_capability(configured_install_mode(), runtime_mode())

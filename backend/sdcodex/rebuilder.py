"""Rebuild-required flag + self-rebuild.

Plugin installs/uninstalls/volume changes (and core updates, which bake a new
frontend into the image) need a container rebuild to take effect. This module:

* tracks the need in a ``.rebuild-required`` marker file (git-ignored),
* rebuilds via the Docker SDK over the mounted socket: image build from the
  mounted repo, then self-replace with compose-merged mounts/env,
* restarts the backend process on bare metal (repo runs live from disk).
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


# ------------------------------------------------- compose merge --------

_INTERP_RE = re.compile(r"\$\{([^}:]+)(?::-(.*?))?\}|\$([A-Za-z_][A-Za-z0-9_]*)")


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


def _interp(value: str, env: dict) -> str:
    def sub(m: re.Match) -> str:
        if m.group(3) is not None:
            return env.get(m.group(3), "")
        var, default = m.group(1), m.group(2)
        if var in env and env[var] != "":
            return env[var]
        return default if default is not None else ""

    return _INTERP_RE.sub(sub, value)


def _load_service(root: str) -> dict:
    """Merge services.sdcodex from docker-compose.yml + override (+ .env)."""
    try:
        import yaml
    except ImportError:
        return {}
    env = dict(os.environ)
    env.update(_load_dotenv(root))
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


def _split_bind(spec: str):
    """host:container[:opts] (long-form dicts pass through as-is)."""
    if isinstance(spec, dict):
        return spec
    parts = spec.split(":")
    if len(parts) < 2:
        return None
    host, cont = parts[0], parts[1]
    mode = parts[2] if len(parts) > 2 else "rw"
    if host.startswith("."):
        host = os.path.abspath(os.path.join(root_dir(), host))
    return (host, {"bind": cont, "mode": mode})


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
        binds = {}
        for spec in cfg.get("volumes", []):
            b = _split_bind(spec)
            if isinstance(b, tuple):
                binds[b[0]] = b[1]
        # stale sibling from a previous attempt
        try:
            stale = client.containers.get(new_name)
            stale.remove(force=True)
            _rlog("removed stale sibling")
        except Exception:
            pass
        _rlog("creating sibling container (no ports — old self holds 5000)")
        client.containers.run(
            IMAGE_TAG,
            name=new_name,
            detach=True,
            environment=cfg.get("environment", {}),
            volumes=binds,
            restart_policy={"Name": "unless-stopped"},
        )
        _rlog("sibling started, waiting for health")
        if not _wait_healthy(client, new_name):
            _rlog("sibling never healthy — keeping current container")
            try:
                bad = client.containers.get(new_name)
                bad.remove(force=True)
            except Exception:
                pass
            return
        me_id = socket.gethostname()
        me = client.containers.get(me_id)
        cname = cfg.get("container_name", "sdcodex")
        # The sibling starts WITHOUT published ports (5000 is held by us);
        # health is checked via exec. Only after it proves healthy do we
        # free the port by stopping ourselves, then start it.
        _rlog("starting sibling (no published ports yet)")
        try:
            new = client.containers.get(new_name)
            new.start()
        except Exception as e:
            _rlog(f"sibling start failed — keeping current container: {e}")
            return
        _rlog("sibling started, waiting for health")
        if not _wait_healthy(client, new_name):
            _rlog("sibling never healthy — keeping current container")
            try:
                bad = client.containers.get(new_name)
                bad.remove(force=True)
            except Exception:
                pass
            return
        _rlog("sibling healthy — stopping old self to free the port")
        try:
            me.stop(timeout=30)
        except Exception as e:
            _rlog(f"stop old self failed: {e}")
            return
        _rlog("starting sibling with the port")
        try:
            new.stop(timeout=10)
            new.remove()
        except Exception as e:
            _rlog(f"sibling teardown failed: {e}")
        try:
            final = client.containers.run(
                IMAGE_TAG,
                name=new_name,
                detach=True,
                environment=cfg.get("environment", {}),
                ports=_port_map(cfg.get("ports", [])),
                volumes=binds,
                restart_policy={"Name": cfg.get("restart", "unless-stopped")},
            )
        except Exception as e:
            _rlog(f"final start failed — RESTARTING OLD SELF: {e}")
            try:
                me.start()
            except Exception as e2:
                _rlog(f"old self restart also failed: {e2}")
            return
        try:
            me.rename("sdcodex-old")
        except Exception as e:
            _rlog(f"rename old failed: {e}")
        try:
            final.rename(cname)
        except Exception as e:
            _rlog(f"rename new failed: {e}")
        try:
            me.remove()
        except Exception:
            pass
        clear_rebuild()
        _rlog("swap done")
    except Exception:
        logger.error("Rebuild failed", exc_info=True)
        try:
            _rlog("rebuild exception — see backend log")
        except Exception:
            pass


def _port_map(ports: list) -> dict:
    out = {}
    for spec in ports:
        s = str(spec)
        if ":" in s:
            host, cont = s.rsplit(":", 1)
            out[f"{cont}/tcp"] = int(host)
        else:
            out[f"{s}/tcp"] = None
    return out


def _restart_process() -> None:
    """Bare metal: re-exec the backend (code runs live from disk)."""
    time.sleep(2)
    clear_rebuild()
    run_py = os.path.join(root_dir(), "backend", "run.py")
    logger.warning("Restarting backend process")
    os.execv(sys.executable, [sys.executable, run_py])


def start_rebuild() -> tuple[bool, str]:
    """Kick off a rebuild/restart in the background. Returns ack immediately."""
    if in_docker() and socket_available():
        t = threading.Thread(target=_rebuild_container, daemon=True)
        t.start()
        return True, "Rebuild started — image build takes several minutes. The app will come back on its own."
    if in_docker():
        return False, "Docker socket not mounted — cannot rebuild from inside. Recreate the container on the host."
    t = threading.Thread(target=_restart_process, daemon=True)
    t.start()
    return True, "Backend restarting…"


def rebuild_capability() -> dict:
    if in_docker() and socket_available():
        return {"can_rebuild": True, "mode": "docker"}
    if in_docker():
        return {"can_rebuild": False, "mode": "docker-nosocket"}
    return {"can_rebuild": True, "mode": "baremetal"}

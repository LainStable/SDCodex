"""One-shot swap executor for blue-green self-rebuild.

Runs as a SHORT-LIVED HELPER CONTAINER (auto-removed on exit), not inside
the app container: the app thread cannot survive `stop`ing its own
container, so every rebuild used to die right after "stopping old self"
and the swap (recreate-with-ports, rename, cleanup) never ran.

The app thread (rebuilder._rebuild_container) builds the image, starts the
port-less sibling, waits for health, then spawns this helper with the swap
spec in SWAP_SPEC_JSON and returns. This helper performs the irreversible
steps and appends to SWAP_LOG (the repo's .rebuild.log bind-mounted at
/swap.log), so the frontend log stream keeps working while the backend
itself is down.
"""

import json
import os
import sys
import time


def log(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    try:
        with open(os.environ.get("SWAP_LOG", "/app/.rebuild.log"), "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def wait_healthy(client, name: str, timeout_s: int = 420) -> bool:
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
            log(f"health wait: {e}")
        time.sleep(10)
    return False


def main() -> int:
    try:
        spec = json.loads(os.environ["SWAP_SPEC_JSON"])
    except Exception as e:
        log(f"SWAP_SPEC_JSON missing/invalid: {e}")
        return 2
    import docker

    client = docker.DockerClient(base_url="unix:///var/run/docker.sock", timeout=1200)
    old_id = spec["old_id"]
    sibling = spec.get("sibling", "sdcodex-new")
    cname = spec.get("cname", "sdcodex")
    ports = spec.get("ports", {"5000/tcp": 5000})
    binds = spec.get("binds", {})
    environment = spec.get("environment", {})
    networks = spec.get("networks", [])
    restart = spec.get("restart", "unless-stopped")
    image = spec.get("image", "sdcodex:latest")

    def get(name):
        try:
            return client.containers.get(name)
        except Exception:
            return None

    old = get(old_id)
    if old is None:
        log("old self not found — aborting swap")
        return 1

    log("helper: stopping old self to free the port")
    try:
        old.stop(timeout=30)
    except Exception as e:
        log(f"stop old self failed: {e}")
        return 1

    log("helper: recreating sibling with the port mapping")
    sib = get(sibling)
    if sib is not None:
        try:
            sib.stop(timeout=10)
        except Exception:
            pass
        try:
            sib.remove()
        except Exception as e:
            log(f"sibling teardown failed: {e}")
            try:
                old.start()
            except Exception as e2:
                log(f"old self restart also failed: {e2}")
            return 1
    for stale_name in ("sdcodex-old",):
        stale = get(stale_name)
        if stale is not None:
            try:
                stale.remove(force=True)
            except Exception:
                pass
    try:
        final = client.containers.run(
            image,
            name=sibling,
            detach=True,
            environment=environment,
            ports=ports,
            volumes=binds,
            restart_policy={"Name": restart},
        )
    except Exception as e:
        log(f"final start failed — RESTARTING OLD SELF: {e}")
        try:
            old.start()
        except Exception as e2:
            log(f"old self restart also failed: {e2}")
        return 1
    for net_name in networks:
        try:
            client.networks.get(net_name).connect(final)
        except Exception as e:
            log(f"final network {net_name}: {e}")
    log("helper: final started, waiting for health")
    if not wait_healthy(client, sibling):
        log("final never healthy — RESTARTING OLD SELF")
        try:
            bad = get(sibling)
            if bad is not None:
                bad.remove(force=True)
        except Exception:
            pass
        try:
            old.start()
        except Exception as e2:
            log(f"old self restart also failed: {e2}")
        return 1
    try:
        old.rename("sdcodex-old")
    except Exception as e:
        log(f"rename old failed: {e}")
    try:
        final.rename(cname)
    except Exception as e:
        log(f"rename new failed: {e}")
    try:
        gone = get("sdcodex-old")
        if gone is not None:
            gone.remove()
    except Exception:
        pass
    try:
        os.remove("/app/.rebuild-required")
    except Exception:
        pass
    log("swap done")
    return 0


if __name__ == "__main__":
    sys.exit(main())

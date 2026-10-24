import os
import threading
import time

import requests

BASE_URL = "https://civitai.com/api/v1"
# Civitai occasionally stalls; every call must have a hard ceiling or a
# background download/scan worker blocks forever.
# Cloudflare fronts the app: any request held past ~100 s becomes a 524 and
# clients retry, which piles more work onto waitress. Keep upstream calls well
# below that ceiling.
TIMEOUT = (5, 15)
USER_AGENT = "SDCodex/1.0 (+https://github.com/LainStable/SDCodex)"

_session = requests.Session()
_session.headers.update({"User-Agent": USER_AGENT})


class CivitaiRateLimited(Exception):
    """Raised locally (no network call) while a 429 cooldown is active."""


# Civitai returns 429 quickly when several background checks run at once
# (library update badges, base-model lookups, scans). Serialize outbound calls
# and back off globally after a 429 so the app stops hammering it.
MIN_INTERVAL = float(os.environ.get("CIVITAI_MIN_INTERVAL", "0.5"))
_RATE_LOCK = threading.Lock()
_RATE_NEXT_AT = 0.0
_RATE_COOLDOWN_UNTIL = 0.0
_RATE_COOLDOWN = 60.0


def rate_limit_check() -> None:
    with _RATE_LOCK:
        if time.time() < _RATE_COOLDOWN_UNTIL:
            raise CivitaiRateLimited("Civitai 429 cooldown — try again shortly")


def rate_limit_wait() -> None:
    global _RATE_NEXT_AT
    with _RATE_LOCK:
        now = time.time()
        start = max(now, _RATE_NEXT_AT)
        _RATE_NEXT_AT = start + MIN_INTERVAL
        delay = start - now
    if delay > 0:
        time.sleep(delay)


def rate_limit_note(status: int) -> None:
    global _RATE_COOLDOWN_UNTIL, _RATE_COOLDOWN
    with _RATE_LOCK:
        if status == 429:
            _RATE_COOLDOWN_UNTIL = max(_RATE_COOLDOWN_UNTIL, time.time() + _RATE_COOLDOWN)
            _RATE_COOLDOWN = min(_RATE_COOLDOWN * 2, 900.0)
        elif 200 <= status < 300:
            _RATE_COOLDOWN = 60.0


def _get_headers(api_key=None):
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _get(path, params=None, api_key=None):
    rate_limit_check()
    rate_limit_wait()
    response = _session.get(
        f"{BASE_URL}{path}",
        params=params,
        headers=_get_headers(api_key),
        timeout=TIMEOUT,
    )
    rate_limit_note(response.status_code)
    response.raise_for_status()
    return response.json()


def get_models(params=None, api_key=None):
    """
    Fetches models from the Civitai API.
    """
    return _get("/models", params=params, api_key=api_key)


def get_model(model_id, api_key=None):
    """
    Fetches a single model from the Civitai API.
    """
    return _get(f"/models/{model_id}", api_key=api_key)


def get_creators(params=None, api_key=None):
    """
    Fetches creators from the Civitai API.
    """
    return _get("/creators", params=params, api_key=api_key)


def get_creator(creator_id, api_key=None):
    """
    Fetches a single creator from the Civitai API.
    """
    return _get(f"/creators/{creator_id}", api_key=api_key)


def get_user(api_key):
    """
    Fetches the current user's details using the API key.
    """
    for path in ("/me", "/account"):
        try:
            return _get(path, api_key=api_key)
        except requests.HTTPError:
            continue
        except requests.RequestException:
            return None
    return None


def get_tags(params=None, api_key=None):
    """
    Fetches tags from the Civitai API.
    """
    return _get("/tags", params=params, api_key=api_key)


def get_model_version_by_hash(file_hash, api_key=None):
    """
    Fetches a model version by its file hash.
    """
    return _get(f"/model-versions/by-hash/{file_hash}", api_key=api_key)

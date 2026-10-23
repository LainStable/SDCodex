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


def _get_headers(api_key=None):
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _get(path, params=None, api_key=None):
    response = _session.get(
        f"{BASE_URL}{path}",
        params=params,
        headers=_get_headers(api_key),
        timeout=TIMEOUT,
    )
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

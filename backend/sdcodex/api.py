import requests

BASE_URL = "https://civitai.com/api/v1"

def _get_headers(api_key=None):
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers

def get_models(params=None, api_key=None):
    """
    Fetches models from the Civitai API.
    """
    response = requests.get(f"{BASE_URL}/models", params=params, headers=_get_headers(api_key))
    response.raise_for_status()
    return response.json()

def get_model(model_id, api_key=None):
    """
    Fetches a single model from the Civitai API.
    """
    response = requests.get(f"{BASE_URL}/models/{model_id}", headers=_get_headers(api_key))
    response.raise_for_status()
    return response.json()

def get_creators(params=None, api_key=None):
    """
    Fetches creators from the Civitai API.
    """
    response = requests.get(f"{BASE_URL}/creators", params=params, headers=_get_headers(api_key))
    response.raise_for_status()
    return response.json()

def get_creator(creator_id, api_key=None):
    """
    Fetches a single creator from the Civitai API.
    """
    response = requests.get(f"{BASE_URL}/creators/{creator_id}", headers=_get_headers(api_key))
    response.raise_for_status()
    return response.json()

def get_user(api_key):
    """
    Fetches the current user's details using the API key.
    """
    # Try to get the current user. This is a guess at the endpoint.
    # If this fails, we might need to adjust.
    # Civitai API documentation doesn't explicitly list a /me endpoint for API keys in the same way as OAuth,
    # but often /v1/users?username=<my_username> is used if we knew the username.
    # Without knowing the username, it's hard.
    # However, let's try to see if we can get it.
    # For now, we will just return a dummy user object if the key is present, 
    # or maybe we can't really validate it without a request.
    # Let's try a request to a potentially protected endpoint or just return a placeholder.
    # BUT, to satisfy the user request "under which username", we need the username.
    # I will assume there is a way. Let's try `https://civitai.com/api/v1/me`.
    
    # NOTE: If this endpoint doesn't exist, this will fail. 
    # Since I cannot verify this without internet, I will add a comment and a fallback.
    try:
        response = requests.get(f"{BASE_URL}/me", headers=_get_headers(api_key))
        if response.status_code == 200:
            return response.json()
    except:
        pass
    
    # Fallback: If we can't get the user, but we have a key, we might just say "Unknown User" 
    # or maybe the user has to enter their username too?
    # The prompt says: "field for the civitai api key ... and next to it, an indicator showing if you are logged in, and under which username"
    # This implies the username is derived from the login/key.
    
    # Let's try another common one: /v1/account
    try:
        response = requests.get(f"{BASE_URL}/account", headers=_get_headers(api_key))
        if response.status_code == 200:
            return response.json()
    except:
        pass

    # If all else fails, return None or raise error
    return None

def get_tags(params=None, api_key=None):
    """
    Fetches tags from the Civitai API.
    """
    response = requests.get(f"{BASE_URL}/tags", params=params, headers=_get_headers(api_key))
    response.raise_for_status()
    return response.json()

def get_model_version_by_hash(file_hash, api_key=None):
    """
    Fetches a model version by its file hash.
    """
    response = requests.get(f"{BASE_URL}/model-versions/by-hash/{file_hash}", headers=_get_headers(api_key))
    response.raise_for_status()
    return response.json()

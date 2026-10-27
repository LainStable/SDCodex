import os
import re
import hashlib
import json
import stat
import tempfile
from datetime import datetime, timezone

import requests
from flask import current_app

from sdcodex import api, db
from sdcodex.models import Setting, Download

# Connect/read ceilings: a stalled Civitai connection must not pin a worker
# thread forever (downloads can still take hours, but each read has a timeout).
CONNECT_TIMEOUT = 10
READ_TIMEOUT = 60
CHUNK_SIZE = 64 * 1024
USER_AGENT = "SDCodex/1.0 (+https://github.com/LainStable/SDCodex)"

_UNSAFE_NAME = re.compile(r'[\x00-\x1f\x7f\\/*?:"<>|]')
_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def sanitize_filename(filename):
    """
    Sanitize a filename so it cannot escape the target directory.
    """
    name = _UNSAFE_NAME.sub("", str(filename or "")).strip()
    # Strip leading dots / traversal remnants and whitespace at either end.
    name = name.lstrip(". ").rstrip(". ")
    if not name:
        return "model"
    stem, ext = os.path.splitext(name)
    if stem.upper() in _RESERVED_NAMES:
        stem = f"_{stem}"
    # Keep names well below filesystem limits.
    return f"{stem[:180]}{ext[:32]}"


class CancelledError(Exception):
    pass


def download_file(url, path, api_key=None, progress_callback=None, is_cancelled=None):
    """
    Download a file from a URL to a local path with progress reporting.
    `is_cancelled` is polled per chunk; a truthy return aborts the download.
    """
    headers = {"User-Agent": USER_AGENT}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    directory = os.path.dirname(os.path.abspath(path)) or "."
    temp_path = None
    try:
        # Write beside the target and rename at the end: an interrupted fetch
        # never leaves a half-written file that looks complete.
        try:
            target_mode = stat.S_IMODE(os.stat(path).st_mode)
        except FileNotFoundError:
            target_mode = 0o644
        fd, temp_path = tempfile.mkstemp(prefix=".sdcodex-dl-", dir=directory)
        os.close(fd)
        with requests.get(
            url, stream=True, headers=headers, timeout=(CONNECT_TIMEOUT, READ_TIMEOUT)
        ) as response:
            response.raise_for_status()
            total_length = response.headers.get('content-length')
            try:
                total = int(total_length) if total_length is not None else 0
            except (TypeError, ValueError):
                total = 0

            downloaded = 0
            with open(temp_path, 'wb') as handle:
                for chunk in response.iter_content(chunk_size=CHUNK_SIZE):
                    if is_cancelled and is_cancelled():
                        raise CancelledError()
                    if not chunk:
                        continue
                    handle.write(chunk)
                    downloaded += len(chunk)
                    if progress_callback and total > 0:
                        # Cap progress below 100: SHA verification reports the
                        # final 99/100 states itself.
                        progress_callback(min(99, int(downloaded / total * 100)))
            if total and downloaded != total:
                raise IOError(f"incomplete download: {downloaded} of {total} bytes")

        if is_cancelled and is_cancelled():
            raise CancelledError()
        os.chmod(temp_path, target_mode)
        os.replace(temp_path, path)
        temp_path = None
    finally:
        if temp_path:
            try:
                os.remove(temp_path)
            except OSError:
                pass


def _stj_escape(text):
    """Escape a string the way .NET's System.Text.Json default encoder does.

    StabilityMatrix is a .NET app and re-reads these sidecars with
    System.Text.Json, whose default JavaScriptEncoder escapes HTML characters,
    quotes, '+', '`' and every non-ASCII code point (uppercase hex).
    """
    out = []
    for ch in text:
        code = ord(ch)
        if ch == '"':
            out.append('\\u0022')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "&":
            out.append("\\u0026")
        elif ch == "'":
            out.append("\\u0027")
        elif ch == "<":
            out.append("\\u003C")
        elif ch == ">":
            out.append("\\u003E")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif code < 0x20:
            out.append(f"\\u{code:04X}")
        elif code > 0x7E:
            # Surrogate pairs come out as two uppercase escapes, like .NET.
            encoded = ch.encode("utf-16-be")
            for i in range(0, len(encoded), 2):
                out.append(f"\\u{int.from_bytes(encoded[i:i + 2], 'big'):04X}")
        else:
            out.append(ch)
    return "".join(out)


def _stj_dumps(value):
    """Compact, System.Text.Json-compatible JSON (no spaces, escaped keys)."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        if isinstance(value, float):
            if value != value or value in (float("inf"), float("-inf")):
                return "null"
            text = repr(value)
            # .NET writes integral doubles without the trailing ".0".
            return text[:-2] if text.endswith(".0") else text
        return str(value)
    if isinstance(value, str):
        return '"' + _stj_escape(value) + '"'
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_stj_dumps(item) for item in value) + "]"
    if isinstance(value, dict):
        return (
            "{"
            + ",".join(f"{_stj_dumps(str(k))}:{_stj_dumps(v)}" for k, v in value.items())
            + "}"
        )
    return _stj_dumps(str(value))


def _atomic_write_text(path, text):
    directory = os.path.dirname(path) or "."
    fd, temporary = tempfile.mkstemp(prefix=".sdcodex-meta-", suffix=".json", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(temporary, path)
    except Exception:
        try:
            os.remove(temporary)
        except OSError:
            pass
        raise


def _atomic_write_json(path, payload):
    _atomic_write_text(path, json.dumps(payload, indent=4))


def _file_format(filename):
    ext = os.path.splitext(filename)[1].lower()
    if ext == ".safetensors":
        return "SafeTensor"
    if ext in (".ckpt", ".pt", ".pth", ".bin"):
        return "PickleTensor"
    if ext == ".gguf":
        return "GGUF"
    if ext == ".onnx":
        return "Onnx"
    return "Other"


def _tag_names(tags):
    out = []
    for tag in tags or []:
        name = tag.get("name") if isinstance(tag, dict) else tag
        if isinstance(name, str) and name.strip():
            out.append(name.strip())
    return out


def _cm_info(model, version, model_id, version_id, model_name, model_type, primary_file):
    """StabilityMatrix ``.cm-info.json`` payload (ConnectedModelInfo record).

    Field-for-field what StabilityMatrix writes when it imports a Civitai
    model, so its "already imported" detection and metadata panel line up with
    files SDCodex downloaded.
    """
    hashes = primary_file.get("hashes") or {}
    stats = model.get("stats") or {}
    creator = model.get("creator") or {}
    remote_name = primary_file.get("name") or ""
    return {
        "ModelId": int(model.get("id") or model_id or 0),
        "ModelName": model.get("name") or model_name or "",
        "ModelDescription": model.get("description") or "",
        "Nsfw": bool(model.get("nsfw", False)),
        "Tags": _tag_names(model.get("tags")),
        "ModelType": model.get("type") or model_type or "",
        "VersionId": int(version.get("id") or version_id or 0),
        "VersionName": version.get("name") or "",
        "VersionDescription": version.get("description"),
        "AuthorUsername": creator.get("username"),
        "BaseModel": version.get("baseModel") or "",
        "RemoteFileName": remote_name,
        "RemoteFileId": primary_file.get("id"),
        "FileMetadata": {
            "fp": None,
            "size": None,
            "format": _file_format(remote_name),
        },
        "ImportedAt": datetime.now(timezone.utc).isoformat(),
        "Hashes": {
            "SHA256": str(hashes.get("SHA256") or "").upper(),
            "CRC32": str(hashes.get("CRC32") or "").upper(),
            "BLAKE3": str(hashes.get("BLAKE3") or "").upper(),
        },
        "TrainedWords": list(version.get("trainedWords") or []),
        "Stats": {
            "favoriteCount": int(stats.get("favoriteCount") or 0),
            "commentCount": int(stats.get("commentCount") or 0),
            "thumbsUpCount": int(stats.get("thumbsUpCount") or 0),
            "downloadCount": int(stats.get("downloadCount") or 0),
            "ratingCount": int(stats.get("ratingCount") or 0),
            "rating": float(stats.get("rating") or 0),
        },
        "UserTitle": None,
        "ThumbnailImageUrl": None,
        "InferenceDefaults": None,
        # ConnectedModelSource.Civitai
        "Source": 0,
        "SourceUrl": None,
    }

def _preview_extension(url):
    lowered = (url or "").lower()
    if ".png" in lowered:
        return ".png"
    if ".jpeg" in lowered or ".jpg" in lowered:
        return ".jpg"
    return ".webp"


def download_model(model_id, version_id, api_key=None, progress_callback=None, is_cancelled=None):
    """
    Download a model version, its preview image, and metadata.
    """
    temp_model_path = None
    try:
        # 1. Fetch model details
        model = api.get_model(model_id, api_key=api_key)
        version = next(
            (v for v in model.get('modelVersions', []) if v.get('id') == version_id), None
        )

        if not version:
            raise ValueError(f"Version {version_id} not found for model {model_id}")

        model_name = model['name']
        model_type = model['type']

        # 2. Determine target directory (primary path for the type).
        # With organize_by_base on, downloads land in <dir>/<BaseModel>/,
        # e.g. checkpoints/Anima/ for an Anima checkpoint.
        setting = db.session.get(Setting, f"dir_{model_type}")
        if setting and setting.value:
            base_dir = setting.value
        else:
            base_dir = os.path.join(current_app.root_path, 'static', 'downloads', model_type)

        org_row = db.session.get(Setting, "organize_by_base")
        if org_row and (org_row.value or "") == "1":
            base_model_name = (version.get('baseModel') or '').strip()
            if base_model_name:
                # Preserve original capitalization and spaces; sanitize only unsafe path chars.
                safe_dir_name = base_model_name.replace('/', '_').replace('\\', '_')
                base_dir = os.path.join(base_dir, safe_dir_name)

        # exist_ok avoids the TOCTOU crash when parallel workers target the
        # same new folder.
        os.makedirs(base_dir, exist_ok=True)

        # 3. Construct filenames
        primary_file = next((f for f in version.get('files', []) if f.get('primary')), None)
        if not primary_file:
            primary_file = version['files'][0] if version.get('files') else None

        if not primary_file:
            raise ValueError("No files found for this version")

        original_filename = primary_file['name']
        base_name = os.path.splitext(original_filename)[0]
        safe_base_name = sanitize_filename(base_name)

        model_ext = os.path.splitext(original_filename)[1][:32]
        model_filename = f"{safe_base_name}{model_ext}"
        # Preview images carry the `.preview` marker before the extension, so
        # they are never mistaken for another model file in the same folder.
        image_filename = f"{safe_base_name}.preview.webp"

        preview_image_url = None
        if version.get('images'):
            preview_image_url = version['images'][0]['url']

        metadata_filename = f"{safe_base_name}.metadata.json"

        model_path = os.path.join(base_dir, model_filename)
        image_path = os.path.join(base_dir, image_filename)
        metadata_path = os.path.join(base_dir, metadata_filename)

        downloaded_files = {}

        # 4. Download files
        # Model file (temp + atomic rename so a crash never leaves a partial
        # file masquerading as a finished model).
        print(f"Downloading model to {model_path}...")
        with tempfile.NamedTemporaryFile(
            prefix=f".{safe_base_name}.", suffix=".part", dir=base_dir, delete=False
        ) as temp_model:
            temp_model_path = temp_model.name
        download_file(
            primary_file['downloadUrl'], temp_model_path, api_key, progress_callback, is_cancelled
        )

        expected_hash = (primary_file.get('hashes') or {}).get('SHA256')
        if expected_hash:
            if progress_callback:
                progress_callback(99, "Verifying SHA256...")
            digest = hashlib.sha256()
            with open(temp_model_path, "rb") as model_file:
                for chunk in iter(lambda: model_file.read(1024 * 1024), b""):
                    if is_cancelled and is_cancelled():
                        raise CancelledError()
                    digest.update(chunk)
            actual_hash = digest.hexdigest()
            if actual_hash.lower() != str(expected_hash).lower():
                raise ValueError(
                    f"SHA256 mismatch: expected {expected_hash}, got {actual_hash}"
                )
            if progress_callback:
                progress_callback(100, "SHA256 verified.")
        elif progress_callback:
            progress_callback(100, "Download complete; no SHA256 checksum was provided.")

        try:
            model_mode = stat.S_IMODE(os.stat(model_path).st_mode)
        except FileNotFoundError:
            model_mode = 0o644
        os.chmod(temp_model_path, model_mode)
        os.replace(temp_model_path, model_path)
        temp_model_path = None
        downloaded_files['model'] = model_path

        # Preview image — also temp + replace so a truncated image is never
        # left beside a valid model.
        if preview_image_url:
            image_ext = _preview_extension(preview_image_url)
            image_path = os.path.join(base_dir, f"{safe_base_name}.preview{image_ext}")

            print(f"Downloading image to {image_path}...")
            with tempfile.NamedTemporaryFile(
                prefix=f".{safe_base_name}.img.", suffix=".part", dir=base_dir, delete=False
            ) as temp_image:
                temp_image_path = temp_image.name
            try:
                download_file(
                    preview_image_url, temp_image_path, api_key, is_cancelled=is_cancelled
                )
                os.replace(temp_image_path, image_path)
                temp_image_path = None
                downloaded_files['image'] = image_path
            finally:
                if temp_image_path and os.path.exists(temp_image_path):
                    os.remove(temp_image_path)

        # Metadata
        print(f"Saving metadata to {metadata_path}...")
        _atomic_write_json(metadata_path, model)
        downloaded_files['metadata'] = metadata_path

        # StabilityMatrix cm-info sidecar when enabled.
        stability_row = db.session.get(Setting, "stabilitymatrix")
        if stability_row and (stability_row.value or "") == "1":
            cm_info_path = os.path.join(base_dir, f"{safe_base_name}.cm-info.json")
            cm_data = _cm_info(
                model, version, model_id, version_id, model_name, model_type, primary_file
            )
            # Compact, System.Text.Json-escaped: StabilityMatrix (a .NET app)
            # writes and re-reads these itself.
            _atomic_write_text(cm_info_path, _stj_dumps(cm_data))
            downloaded_files['cm_info'] = cm_info_path

        # 5. Record in DB (update the row on re-download instead of adding a
        # duplicate library entry).
        download = Download.query.filter_by(model_id=model_id, version_id=version_id).first()
        if download is None:
            download = Download(model_id=model_id, version_id=version_id)
            db.session.add(download)
        download.name = model_name
        download.type = model_type
        download.base_model = version.get('baseModel') or download.base_model
        download.set_files(downloaded_files)
        db.session.commit()

        return True, f"Successfully downloaded {model_name}"

    except Exception as e:
        if temp_model_path:
            try:
                os.remove(temp_model_path)
            except OSError:
                pass
        return False, str(e)

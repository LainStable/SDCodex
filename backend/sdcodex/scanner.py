import hashlib
import json
import os

from sdcodex import api, db
from sdcodex.models import Download
from sdcodex.downloader import download_file, sanitize_filename

MODEL_EXTENSIONS = {'.safetensors', '.ckpt', '.pt', '.bin'}

# Hash cache keyed by (realpath, size, mtime_ns). Re-scanning an unchanged
# multi-GB model is otherwise the slowest part of every scan.
_HASH_CACHE: dict = {}
_HASH_CACHE_LIMIT = 50_000


def calculate_sha256(filepath, block_size=1024 * 1024):
    """Calculate SHA256 hash of a file."""
    sha256 = hashlib.sha256()
    with open(filepath, 'rb') as handle:
        for block in iter(lambda: handle.read(block_size), b''):
            sha256.update(block)
    return sha256.hexdigest()


def _cached_sha256(filepath):
    try:
        stat = os.stat(filepath)
        key = (os.path.realpath(filepath), stat.st_size, stat.st_mtime_ns)
    except OSError:
        return calculate_sha256(filepath)
    cached = _HASH_CACHE.get(key)
    if cached:
        return cached
    digest = calculate_sha256(filepath)
    if len(_HASH_CACHE) >= _HASH_CACHE_LIMIT:
        _HASH_CACHE.clear()
    _HASH_CACHE[key] = digest
    return digest


def infer_base_model(filepath):
    """Read the architecture embedded in a safetensors header.

    Files that Civitai cannot match still carry modelspec / A1111 metadata; use
    it so the Library shows e.g. "SDXL 1.0" instead of "unknown".
    """
    if not str(filepath).lower().endswith('.safetensors'):
        return ''
    try:
        with open(filepath, 'rb') as handle:
            raw = handle.read(8)
            if len(raw) < 8:
                return ''
            length = int.from_bytes(raw, 'little')
            if not length or length > 4 * 1024 * 1024:
                return ''
            header = json.loads(handle.read(length).decode('utf-8', 'ignore'))
    except (OSError, ValueError):
        return ''
    meta = header.get('__metadata__') if isinstance(header, dict) else None
    if not isinstance(meta, dict):
        return ''
    text = ' '.join(
        str(meta.get(key) or '')
        for key in (
            'modelspec.architecture',
            'modelspec.base_model',
            'modelspec.title',
            'ss_base_model_version',
            'ss_sd_model_name',
        )
    ).lower()
    if not text.strip():
        return ''
    if 'flux' in text:
        return 'Flux.1 D'
    if 'pony' in text:
        return 'Pony'
    if 'illustrious' in text:
        return 'Illustrious'
    if 'noobai' in text:
        return 'NoobAI'
    if any(token in text for token in ('sdxl', 'sd_xl', 'xl_base', 'stable-diffusion-xl')):
        return 'SDXL 1.0'
    if any(token in text for token in ('sd_3', 'sd3', 'stable-diffusion-3')):
        return 'SD 3'
    if any(token in text for token in ('sd15', 'sd_v1', 'stable-diffusion-v1')):
        return 'SD 1.5'
    if any(token in text for token in ('sd_2', 'sd2', 'stable-diffusion-2')):
        return 'SD 2.1'
    return ''


def _version_from_metadata(data, filename):
    """Identify a version from our saved metadata without hashing the model."""
    if not isinstance(data, dict):
        return None

    # StabilityMatrix ConnectedModelInfo (`.cm-info.json`, PascalCase fields).
    if data.get("ModelId") and data.get("VersionId"):
        try:
            model_id = int(data.get("ModelId") or 0)
            version_id = int(data.get("VersionId") or 0)
        except (TypeError, ValueError):
            return None
        if not model_id or not version_id:
            return None
        return {
            "id": version_id,
            "modelId": model_id,
            "name": data.get("VersionName") or "",
            "baseModel": data.get("BaseModel") or "",
            "files": [{"name": filename, "hashes": data.get("Hashes") or {}}],
            "images": [],
            "model": {
                "name": data.get("ModelName") or "Unknown Model",
                "type": data.get("ModelType") or "Other",
            },
        }

    def matches(version):
        files = version.get("files")
        if not isinstance(files, list) or not files:
            return False
        return any(
            os.path.basename(str(f.get("name") or "")) == filename
            for f in files
            if isinstance(f, dict)
        )

    versions = data.get("modelVersions")
    if isinstance(versions, list) and versions:
        # The downloader saves the full model object; pick the version whose
        # file matches (or the only version, for renamed files).
        chosen = next(
            (v for v in versions if isinstance(v, dict) and matches(v)),
            None,
        )
        if chosen is None and len(versions) == 1 and isinstance(versions[0], dict):
            chosen = versions[0]
        if chosen is not None:
            enriched = dict(chosen)
            # Version objects in a model payload carry no modelId of their own.
            enriched.setdefault("modelId", data.get("id"))
            enriched.setdefault(
                "model", {"name": data.get("name", "Unknown Model"), "type": data.get("type", "Other")}
            )
            return enriched
        return None

    if data.get("id") and data.get("modelId"):
        # A version object (get_model_version_by_hash shape).
        if data.get("files") and not matches(data):
            return None
        enriched = dict(data)
        model = data.get("model") if isinstance(data.get("model"), dict) else {}
        enriched.setdefault("model", {"name": model.get("name", "Unknown Model"), "type": model.get("type", "Other")})
        return enriched
    return None


META_SUFFIXES = ('.metadata.json', '.cm-info.json')
IMAGE_SUFFIXES = ('.webp', '.png', '.jpg', '.jpeg', '.preview.png')


def _read_sidecar(file_dir, base_name):
    """First readable JSON sidecar next to a model.

    Supports both formats in the wild: Civitai's `<name>.metadata.json` and
    StabilityMatrix's `<name>.cm-info.json`.
    """
    for suffix in META_SUFFIXES:
        path = os.path.join(file_dir, f"{base_name}{suffix}")
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding='utf-8') as handle:
                return path, json.load(handle)
        except (OSError, ValueError):
            continue
    return None, None


def _find_image(file_dir, base_name):
    for ext in IMAGE_SUFFIXES:
        path = os.path.join(file_dir, f"{base_name}{ext}")
        if os.path.exists(path):
            return path
    return os.path.join(file_dir, f"{base_name}.webp")


def scan_directory(directory, model_type, api_key=None, progress_callback=None):
    """
    Scan a directory for models, identify them, and download missing metadata/images.

    Two passes: first read sidecars for every model (no hashing), then hash and
    query Civitai only for the files that had no usable metadata.
    """
    if not os.path.isdir(directory):
        return 0, "Directory does not exist", []

    # Recursive: users sort models into subfolders. Permission errors in one
    # subtree should not abort the whole scan.
    model_files = []
    for root, _dirs, files in os.walk(directory, onerror=lambda _e: None):
        for name in files:
            if os.path.splitext(name)[1].lower() in MODEL_EXTENSIONS:
                model_files.append(os.path.join(root, name))

    total_files = len(model_files)
    updated_count = 0
    found_ids = []

    # Pass 1 — sidecars only. A model with a Civitai metadata file or a
    # StabilityMatrix cm-info file is identified without reading the weights.
    identified = {}
    sidecar_identified = set()
    sidecars = {}
    pending = []
    for index, filepath in enumerate(model_files, start=1):
        if not os.path.isfile(filepath):
            continue
        filename = os.path.basename(filepath)
        base_name = os.path.splitext(filename)[0]
        file_dir = os.path.dirname(filepath)
        if progress_callback and total_files:
            progress_callback(
                int(index / total_files * 95), f"Reading metadata for {filename}..."
            )
        sidecar_path, sidecar = _read_sidecar(file_dir, base_name)
        if sidecar_path:
            sidecars[filepath] = sidecar_path
        version = _version_from_metadata(sidecar, filename) if sidecar is not None else None
        if version:
            identified[filepath] = version
            sidecar_identified.add(filepath)
        else:
            pending.append(filepath)

    # Everything without a usable sidecar is listed as unidentified. Hashing
    # is an explicit "Identify models" action (identify_unmatched), so a scan
    # stays fast and never talks to Civitai.

    for filepath in model_files:
        if not os.path.isfile(filepath):
            continue
        filename = os.path.basename(filepath)
        base_name = os.path.splitext(filename)[0]
        file_dir = os.path.dirname(filepath)

        metadata_path = sidecars.get(filepath) or os.path.join(file_dir, f"{base_name}.metadata.json")
        image_path = _find_image(file_dir, base_name)
        model_version = identified.get(filepath)
        from_sidecar = filepath in sidecar_identified

        if not model_version:
            # Unknown (maybe not hosted on Civitai): still list the model.
            # Reuse a sidecar image / info file when the folder already has
            # them; the placeholder covers the rest.
            import zlib

            downloaded_files = {'model': filepath}
            if metadata_path and os.path.exists(metadata_path):
                downloaded_files['metadata'] = metadata_path
            if os.path.exists(image_path):
                downloaded_files['image'] = image_path
            stand_in = zlib.crc32(f"{model_type}/{filepath}".encode()) & 0x7FFFFFFF
            existing = Download.query.filter_by(model_id=0, version_id=stand_in).first()
            inferred_base = infer_base_model(filepath)
            if not existing:
                download = Download(
                    model_id=0,
                    version_id=stand_in,
                    name=base_name,
                    type=model_type,
                )
                download.set_files(downloaded_files)
                download.base_model = inferred_base or None
                db.session.add(download)
                updated_count += 1
            else:
                existing.set_files(downloaded_files)
                existing.base_model = inferred_base or existing.base_model
            db.session.commit()
            found_ids.append((0, stand_in))
            continue

        # We identified the version.
        version_id = model_version.get('id')
        model_id = model_version.get('modelId')
        if not version_id or not model_id:
            # Can't reconcile this file against the library; leave it alone
            # instead of crashing the whole scan.
            print(f"Identified version for {filename} is missing identifiers; skipping")
            continue
        model_details = model_version.get('model') or {}
        model_name = model_details.get('name', 'Unknown Model')

        downloaded_files = {'model': filepath}

        if from_sidecar:
            # The folder already carried the metadata (and possibly an image):
            # no network calls for this model.
            downloaded_files['metadata'] = metadata_path
            if os.path.exists(image_path):
                downloaded_files['image'] = image_path
        else:
            if not os.path.exists(metadata_path):
                try:
                    full_model = api.get_model(model_id, api_key)
                    with open(metadata_path, 'w', encoding='utf-8') as handle:
                        json.dump(full_model, handle, indent=4)
                    downloaded_files['metadata'] = metadata_path
                    updated_count += 1
                except Exception as exc:
                    print(f"Failed to download metadata for {filename}: {exc}")
            else:
                downloaded_files['metadata'] = metadata_path

            if not os.path.exists(image_path):
                if model_version.get('images'):
                    image_url = model_version['images'][0]['url']
                    if '.png' in image_url:
                        ext = '.png'
                    elif '.jpg' in image_url or '.jpeg' in image_url:
                        ext = '.jpg'
                    else:
                        ext = '.webp'

                    new_image_path = os.path.join(file_dir, f"{sanitize_filename(base_name)}{ext}")
                    try:
                        download_file(image_url, new_image_path, api_key)
                        downloaded_files['image'] = new_image_path
                        updated_count += 1
                    except Exception as exc:
                        print(f"Failed to download image for {filename}: {exc}")
            else:
                downloaded_files['image'] = image_path

        existing = Download.query.filter_by(model_id=model_id, version_id=version_id).first()
        if not existing:
            download = Download(
                model_id=model_id,
                version_id=version_id,
                name=model_name,
                type=model_type
            )
            download.set_files(downloaded_files)
            db.session.add(download)
            updated_count += 1
        else:
            existing.set_files(downloaded_files)
            download = existing
        download.base_model = model_version.get('baseModel') or infer_base_model(filepath) or download.base_model

        db.session.commit()
        found_ids.append((model_id, version_id))

    return updated_count, f"Scanned {total_files} files, updated {updated_count} models.", found_ids


def identify_unmatched(api_key=None, progress_callback=None):
    """Hash and Civitai-match every library row that is still unidentified.

    Scans never hash now; this is the explicit follow-up the user triggers from
    Settings -> Model dirs ("Identify models"). Returns (count, message, []).
    """
    rows = Download.query.filter_by(model_id=0).order_by(Download.id).all()
    total = len(rows)
    identified = 0
    for index, row in enumerate(rows, start=1):
        files = row.get_files() or {}
        path = files.get("model") or ""
        display = os.path.basename(path) or row.name or "model"
        if progress_callback:
            progress_callback(
                int(index / max(1, total) * 100), f"Identifying {display} ({index}/{total})"
            )
        if not path or not os.path.isfile(path):
            continue
        try:
            file_hash = _cached_sha256(path)
            version = api.get_model_version_by_hash(file_hash, api_key)
        except Exception as exc:
            print(f"Failed to identify {display}: {exc}")
            continue
        if not version:
            continue
        version_id = version.get("id")
        model_id = version.get("modelId")
        if not version_id or not model_id:
            continue

        # A second copy of an already-identified file: merge and drop this row.
        existing = Download.query.filter_by(model_id=model_id, version_id=version_id).first()
        if existing is not None and existing.id != row.id:
            merged = dict(existing.get_files() or {})
            for key, value in files.items():
                if value and not merged.get(key):
                    merged[key] = value
            existing.set_files(merged)
            db.session.delete(row)
            db.session.commit()
            identified += 1
            continue

        base_name = os.path.splitext(os.path.basename(path))[0]
        file_dir = os.path.dirname(path)
        new_files = dict(files)
        new_files["model"] = path

        metadata_path = os.path.join(file_dir, f"{base_name}.metadata.json")
        if not os.path.exists(metadata_path):
            try:
                full_model = api.get_model(model_id, api_key)
                with open(metadata_path, "w", encoding="utf-8") as handle:
                    json.dump(full_model, handle, indent=4)
            except Exception as exc:
                print(f"Failed to download metadata for {display}: {exc}")
        if os.path.exists(metadata_path):
            new_files["metadata"] = metadata_path

        image_path = _find_image(file_dir, base_name)
        if not os.path.exists(image_path) and version.get("images"):
            image_url = version["images"][0]["url"]
            ext = (
                ".png" if ".png" in image_url
                else ".jpg" if (".jpg" in image_url or ".jpeg" in image_url)
                else ".webp"
            )
            image_path = os.path.join(file_dir, f"{sanitize_filename(base_name)}{ext}")
            try:
                download_file(image_url, image_path, api_key)
            except Exception as exc:
                print(f"Failed to download image for {display}: {exc}")
        if os.path.exists(image_path):
            new_files["image"] = image_path

        row.model_id = int(model_id)
        row.version_id = int(version_id)
        row.name = ((version.get("model") or {}).get("name")) or row.name
        row.base_model = version.get("baseModel") or infer_base_model(path) or row.base_model
        row.set_files(new_files)
        db.session.commit()
        identified += 1

    return identified, f"Identified {identified} of {total} unmatched models.", []

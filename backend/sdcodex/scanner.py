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
            if not length or length > 100 * 1024 * 1024:
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
    if isinstance(versions, list):
        # The downloader saves the full model object.
        for version in versions:
            if isinstance(version, dict) and matches(version):
                enriched = dict(version)
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


def scan_directory(directory, model_type, api_key=None, progress_callback=None):
    """
    Scan a directory for models, identify them, and download missing metadata/images.
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
    processed = 0
    updated_count = 0
    found_ids = []

    for filepath in model_files:
        if not os.path.isfile(filepath):
            continue
        filename = os.path.basename(filepath)
        base_name = os.path.splitext(filename)[0]
        file_dir = os.path.dirname(filepath)

        processed += 1
        if progress_callback and total_files:
            progress_callback(
                int(processed / total_files * 100), f"Scanning {filename}..."
            )

        # Check for metadata (sidecars live next to the model file)
        metadata_path = os.path.join(file_dir, f"{base_name}.metadata.json")
        image_path = os.path.join(file_dir, f"{base_name}.webp")  # Default check
        if not os.path.exists(image_path):
            for ext in ['.png', '.jpg', '.jpeg', '.preview.png']:
                alt_path = os.path.join(file_dir, f"{base_name}{ext}")
                if os.path.exists(alt_path):
                    image_path = alt_path
                    break

        # 1. Try to load from metadata saved by a previous download/scan.
        model_version = None
        if os.path.exists(metadata_path):
            try:
                with open(metadata_path, encoding='utf-8') as handle:
                    model_version = _version_from_metadata(json.load(handle), filename)
            except (OSError, ValueError):
                model_version = None

        # 2. Only hash/query Civitai when the sidecar did not identify it.
        if not model_version:
            try:
                file_hash = _cached_sha256(filepath)
                model_version = api.get_model_version_by_hash(file_hash, api_key)
            except Exception as exc:
                print(f"Failed to identify {filename}: {exc}")
                model_version = None

        if not model_version:
            # Unknown (maybe not hosted on Civitai): still list the model.
            # Reuse a sidecar image / info file when the folder already has
            # them; the placeholder covers the rest.
            import zlib

            sidecar_image = None
            for ext in ['.png', '.jpg', '.jpeg', '.webp', '.preview.png']:
                candidate = os.path.join(file_dir, f"{base_name}{ext}")
                if os.path.exists(candidate):
                    sidecar_image = candidate
                    break
            downloaded_files = {'model': filepath}
            if os.path.exists(metadata_path):
                downloaded_files['metadata'] = metadata_path
            if sidecar_image:
                downloaded_files['image'] = sidecar_image
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
        model_type_api = model_details.get('type', model_type)  # noqa: F841 (kept for parity)

        downloaded_files = {'model': filepath}

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

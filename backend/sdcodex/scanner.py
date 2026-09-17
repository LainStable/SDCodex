import os
import hashlib
import json
from sdcodex import api, db
from sdcodex.models import Download, Setting
from sdcodex.downloader import download_file, sanitize_filename
from flask import current_app

MODEL_EXTENSIONS = {'.safetensors', '.ckpt', '.pt', '.bin'}

def calculate_sha256(filepath, block_size=65536):
    """Calculate SHA256 hash of a file."""
    sha256 = hashlib.sha256()
    with open(filepath, 'rb') as f:
        for block in iter(lambda: f.read(block_size), b''):
            sha256.update(block)
    return sha256.hexdigest()

def scan_directory(directory, model_type, api_key=None, progress_callback=None):
    """
    Scan a directory for models, identify them, and download missing metadata/images.
    """
    if not os.path.exists(directory):
        return 0, "Directory does not exist", []

    # Recursive: users sort models into subfolders.
    model_files = []
    for root, _dirs, files in os.walk(directory):
        for f in files:
            if os.path.splitext(f)[1].lower() in MODEL_EXTENSIONS:
                model_files.append(os.path.join(root, f))

    total_files = len(model_files)
    processed = 0
    updated_count = 0
    found_ids = []

    for filepath in model_files:
        filename = os.path.basename(filepath)
        base_name = os.path.splitext(filename)[0]
        file_dir = os.path.dirname(filepath)

        # Report progress
        processed += 1
        if progress_callback:
            progress_callback(int(processed / total_files * 100), f"Scanning {filename}...")

        # Check for metadata (sidecars live next to the model file)
        metadata_path = os.path.join(file_dir, f"{base_name}.metadata.json")
        image_path = os.path.join(file_dir, f"{base_name}.webp") # Default check
        # Also check other image exts if webp missing
        if not os.path.exists(image_path):
            for ext in ['.png', '.jpg', '.jpeg', '.preview.png']:
                alt_path = os.path.join(file_dir, f"{base_name}{ext}")
                if os.path.exists(alt_path):
                    image_path = alt_path
                    break

        model_version = None
        
        # 1. Try to load from metadata
        if os.path.exists(metadata_path):
            try:
                with open(metadata_path, 'r') as f:
                    data = json.load(f)
                    # Check if it looks like a model version or model
                    if 'id' in data and 'modelId' in data:
                        # It's likely a version object (from get_model_version)
                        # Or a model object (from get_model) which has 'id' as modelId.
                        # Wait, get_model returns model object. get_model_version returns version object.
                        # Our downloader saves the *Model* object (with versions list).
                        # If we saved the model object, data['id'] is model_id.
                        # But we need version_id.
                        # If we saved model object, we can't easily know which version this file belongs to 
                        # unless we match filename to files in versions.
                        pass
            except:
                pass

        # 2. If not identified or missing metadata, calculate hash
        file_hash = None
        if not model_version:
            try:
                file_hash = calculate_sha256(filepath)
                model_version = api.get_model_version_by_hash(file_hash, api_key)
            except Exception as e:
                print(f"Failed to identify {filename}: {e}")
                model_version = None

        if not model_version:
            # Unknown (maybe not hosted on Civitai): still list the model.
            # Reuse a sidecar image / info file when the folder already has
            # them; the placeholder covers the rest.
            import zlib

            sidecar_image = None
            for ext in ['.png', '.jpg', '.jpeg', '.webp', '.preview.png']:
                cand = os.path.join(file_dir, f"{base_name}{ext}")
                if os.path.exists(cand):
                    sidecar_image = cand
                    break
            downloaded_files = {'model': filepath}
            if os.path.exists(metadata_path):
                downloaded_files['metadata'] = metadata_path
            if sidecar_image:
                downloaded_files['image'] = sidecar_image
            stand_in = zlib.crc32(f"{model_type}/{filepath}".encode()) & 0x7FFFFFFF
            existing = Download.query.filter_by(model_id=0, version_id=stand_in).first()
            if not existing:
                download = Download(
                    model_id=0,
                    version_id=stand_in,
                    name=base_name,
                    type=model_type,
                )
                download.set_files(downloaded_files)
                db.session.add(download)
                updated_count += 1
            else:
                existing.set_files(downloaded_files)
            db.session.commit()
            found_ids.append((0, stand_in))
            continue

        if model_version:
            # We identified the version!
            version_id = model_version['id']
            model_id = model_version['modelId']
            
            # Fetch full model details to get type and name if needed, 
            # but model_version usually has model info too?
            # get_model_version_by_hash returns the version object.
            # It usually contains 'model' dict with name and type.
            
            model_name = model_version.get('model', {}).get('name', 'Unknown Model')
            model_type_api = model_version.get('model', {}).get('type', model_type)
            
            # 3. Download missing files
            downloaded_files = {'model': filepath}
            
            # Metadata
            if not os.path.exists(metadata_path):
                # We need full model details for the metadata file we usually save?
                # Downloader saves `api.get_model(model_id)`.
                # Let's do that to be consistent.
                try:
                    full_model = api.get_model(model_id, api_key)
                    with open(metadata_path, 'w') as f:
                        json.dump(full_model, f, indent=4)
                    downloaded_files['metadata'] = metadata_path
                    updated_count += 1
                except Exception as e:
                    print(f"Failed to download metadata for {filename}: {e}")

            else:
                downloaded_files['metadata'] = metadata_path

            # Image
            if not os.path.exists(image_path):
                if model_version.get('images'):
                    image_url = model_version['images'][0]['url']
                    # Determine ext
                    if '.png' in image_url: ext = '.png'
                    elif '.jpg' in image_url or '.jpeg' in image_url: ext = '.jpg'
                    else: ext = '.webp'
                    
                    new_image_path = os.path.join(file_dir, f"{base_name}{ext}")
                    try:
                        download_file(image_url, new_image_path, api_key)
                        downloaded_files['image'] = new_image_path
                        updated_count += 1
                    except Exception as e:
                        print(f"Failed to download image for {filename}: {e}")
            else:
                downloaded_files['image'] = image_path

            # 4. Update Database
            # Check if exists. The row is grouped by folder category
            # (model_type), not the API taxonomy — sections follow Settings.
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
                # Update files if changed
                existing.set_files(downloaded_files)
            
            db.session.commit()
            
            # Add to found list
            found_ids.append((model_id, version_id))

    return updated_count, f"Scanned {total_files} files, updated {updated_count} models.", found_ids

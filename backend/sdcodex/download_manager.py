import os
import threading
import time
import queue
from sdcodex.downloader import download_model
from sdcodex import db
from flask import current_app

# Model types with configurable directories (mirrors OldCode routes.MODEL_TYPES).
MODEL_TYPES = [
    "Checkpoint", "Embedding", "Hypernetwork", "AestheticGradient",
    "LORA", "LyCORIS", "DoRA", "Controlnet", "Upscaler", "Motion",
    "VAE", "Poses", "Wildcards", "Workflows", "Detection", "Other",
]


def remove_missing_downloads(found_ids: set, scanned_types: set) -> int:
    """Delete library rows that vanished from *scanned* categories only.

    A type-filtered scan must never delete rows belonging to categories it
    did not walk (that was silently wiping the rest of the library).
    """
    from sdcodex.models import Download

    if not scanned_types:
        return 0
    removed = 0
    for download in Download.query.all():
        if download.type in scanned_types and (download.model_id, download.version_id) not in found_ids:
            db.session.delete(download)
            removed += 1
    if removed:
        db.session.commit()
    return removed

class DownloadManager:
    _instance = None
    HISTORY_LIMIT = 200

    def __new__(cls, app=None):
        if cls._instance is None:
            cls._instance = super(DownloadManager, cls).__new__(cls)
            cls._instance.queue = queue.Queue()
            cls._instance.scan_queue = queue.Queue()
            cls._instance.current_task = None
            cls._instance.active_tasks = []
            cls._instance.history = []
            cls._instance.app = app
            cls._instance.running = False
            cls._instance.lock = threading.Lock()
            cls._instance.workers = 0
            cls._instance.scan_worker_on = False
        return cls._instance

    def _record_history(self, task: dict) -> None:
        """Keep recent history bounded (long-running installs used to leak)."""
        self.history.append(task)
        if len(self.history) > self.HISTORY_LIMIT * 2:
            del self.history[: len(self.history) - self.HISTORY_LIMIT]

    def _sync_current(self) -> None:
        """`current_task` is a summary field; derive it from the live list."""
        self.current_task = self.active_tasks[0] if self.active_tasks else None

    def _finish(self, task: dict) -> None:
        with self.lock:
            self._record_history(task)
            if task in self.active_tasks:
                self.active_tasks.remove(task)
            self._sync_current()

    def init_app(self, app):
        self.app = app
        self.start()

    def max_workers(self):
        """Parallel download limit (Setting max_parallel_downloads, default 1)."""
        try:
            from sdcodex.models import Setting

            with self.app.app_context():
                try:
                    row = db.session.get(Setting, "max_parallel_downloads")
                    return max(1, min(8, int(row.value or 1))) if row else 1
                finally:
                    db.session.remove()
        except Exception:
            return 1

    def start(self):
        if not self.running:
            self.running = True
            self.ensure_workers()
            self.ensure_scan_worker()

    def ensure_workers(self):
        """Top up download worker threads to the configured parallelism."""
        limit = self.max_workers()
        with self.lock:
            while self.workers < limit:
                self.workers += 1
                thread = threading.Thread(target=self._worker, daemon=True)
                thread.start()

    def ensure_scan_worker(self):
        """One dedicated lane for scans so they never block downloads."""
        with self.lock:
            if self.scan_worker_on:
                return
            self.scan_worker_on = True
            thread = threading.Thread(target=self._scan_worker, daemon=True)
            thread.start()

    class _Cancelled(Exception):
        pass

    def _scan_worker(self):
        from sdcodex.models import Setting
        from sdcodex.scanner import scan_directory

        print("DownloadManager scan worker started")
        while True:
            try:
                task = self.scan_queue.get(timeout=5)
            except queue.Empty:
                continue
            try:
                print("Scan worker picked up task")
                with self.lock:
                    self.active_tasks.append(task)
                    self._sync_current()
                task['status'] = 'running'
                task['message'] = 'Starting scan...'

                def progress_callback(percentage, msg=None):
                    if task.get('cancel'):
                        raise DownloadManager._Cancelled()
                    task['progress'] = percentage
                    task['message'] = msg or f"Processing... {percentage}%"

                with self.app.app_context():
                    try:
                        only = task.get("model_types") or None
                        dir_rows = {
                            s.key: (s.value or "").strip()
                            for s in Setting.query.all()
                            if s.key.startswith("dir_") and (s.value or "").strip()
                        }
                        directories = []
                        for m_type in MODEL_TYPES:
                            if only and m_type not in only:
                                continue
                            paths = [dir_rows[f"dir_{m_type}"]] if f"dir_{m_type}" in dir_rows else []
                            extra = sorted(
                                v for k, v in dir_rows.items() if k.startswith(f"dir_{m_type}__")
                            )
                            for path in paths + extra:
                                # Skip paths that are currently unreachable
                                # (unmounted drive, typo): their rows must not
                                # be treated as missing and deleted.
                                if os.path.isdir(path):
                                    directories.append((path, m_type))
                        scanned_types = {m_type for _, m_type in directories}
                        total_updated = 0
                        all_found_ids = set()
                        for directory, m_type in directories:
                            task['message'] = f"Scanning {m_type} directory..."
                            updated, msg, found_ids = scan_directory(
                                directory, m_type, task['api_key'], progress_callback
                            )
                            total_updated += updated
                            all_found_ids.update(found_ids)
                        removed_count = remove_missing_downloads(all_found_ids, scanned_types)
                        message = (
                            f"Scan complete. Updated {total_updated} models. "
                            f"Removed {removed_count} missing models."
                        )
                    finally:
                        db.session.remove()
                print(f"Scan finished: {message}")
                if task.get('cancel'):
                    task['status'] = 'cancelled'
                    task['message'] = 'Cancelled by user'
                    task['progress'] = 0
                else:
                    task['status'] = 'completed'
                    task['message'] = message
                    task['progress'] = 100
            except DownloadManager._Cancelled:
                print("Scan task cancelled")
                task['status'] = 'cancelled'
                task['message'] = 'Cancelled by user'
                task['progress'] = 0
            except Exception as e:
                print(f"Scan worker error: {e}")
                task['status'] = 'failed'
                task['message'] = str(e)
            finally:
                self._finish(task)
                self.scan_queue.task_done()

    def add_task(self, model_id=None, version_id=None, api_key=None, task_type='download', **kwargs):
        task = {
            'type': task_type,
            'model_id': model_id,
            'version_id': version_id,
            'api_key': api_key,
            'status': 'queued',
            'progress': 0,
            'message': 'Queued',
            **kwargs
        }
        self.queue.put(task) if task_type != 'scan' else self.scan_queue.put(task)
        try:
            self.ensure_scan_worker()
            if task_type != 'scan':
                self.ensure_workers()
        except Exception:
            pass
        return task

    def cancel_task(self, model_id=None, version_id=None) -> tuple[bool, str]:
        """Remove a queued download, or flag a running one to abort."""
        with self.lock:
            for t in list(self.active_tasks):
                if t.get('model_id') == model_id and t.get('version_id') == version_id:
                    t['cancel'] = True
                    return True, "Cancelling…"
        kept = []
        removed = False
        try:
            while True:
                t = self.queue.get_nowait()
                if (
                    not removed
                    and t.get('model_id') == model_id
                    and t.get('version_id') == version_id
                ):
                    removed = True
                    t['status'] = 'cancelled'
                    self.history.append(t)
                else:
                    kept.append(t)
        except queue.Empty:
            pass
        for t in kept:
            self.queue.put(t)
        if removed:
            return True, "Removed from queue."
        return False, "Task not found (it may have finished)."

    def get_status(self):
        with self.lock:
            active = list(self.active_tasks)
            recent_history = list(self.history[-5:])
            current = dict(self.current_task) if self.current_task else None
        status = {
            'current_task': (
                {
                    key: current.get(key)
                    for key in ('type', 'model_id', 'version_id', 'status', 'progress', 'message')
                }
                if current else None
            ),
            'active_tasks': [
                {
                    'type': t.get('type'),
                    'model_id': t.get('model_id'),
                    'version_id': t.get('version_id'),
                    'status': t.get('status'),
                    'progress': t.get('progress', 0),
                    'message': t.get('message', ''),
                }
                for t in active
            ],
            'max_parallel': self.max_workers(),
            'queue_length': self.queue.qsize(),
            'scan_queued': self.scan_queue.qsize(),
            'recent_history': [
                {
                    'type': t.get('type'),
                    'model_id': t.get('model_id'),
                    'version_id': t.get('version_id'),
                    'status': t.get('status'),
                    'progress': t.get('progress', 0),
                    'message': t.get('message', ''),
                }
                for t in recent_history
            ],
        }
        return status

    def _worker(self):
        print("DownloadManager worker started")
        while True:
            try:
                # Scale down when the limit was lowered: idle extras exit here.
                limit = self.max_workers()
                with self.lock:
                    if self.workers > limit and self.queue.empty():
                        self.workers -= 1
                        print("DownloadManager worker exiting (limit lowered)")
                        return
                try:
                    task = self.queue.get(timeout=2)
                except queue.Empty:
                    continue
            except Exception:
                # A failure in the housekeeping branch must not kill the worker.
                import traceback

                traceback.print_exc()
                time.sleep(1)
                continue

            try:
                print(f"Worker picked up task: {task.get('type', 'download')} - {task.get('model_id')}")
                with self.lock:
                    self.active_tasks.append(task)
                    self._sync_current()
                task['status'] = 'running'
                task['message'] = 'Starting...'
                success = False
                message = ''

                def progress_callback(percentage, msg=None):
                    if task.get('cancel'):
                        raise DownloadManager._Cancelled()
                    task['progress'] = percentage
                    if msg:
                        task['message'] = msg
                    else:
                        task['message'] = f"Processing... {percentage}%"

                # Use app context for DB access.
                with self.app.app_context():
                    try:
                        success, message = download_model(
                            task['model_id'],
                            task['version_id'],
                            task['api_key'],
                            progress_callback,
                            is_cancelled=lambda: bool(task.get('cancel')),
                        )
                        print(f"Task finished: {success} - {message}")
                    finally:
                        db.session.remove()

                if task.get('cancel'):
                    task['status'] = 'cancelled'
                    task['message'] = 'Cancelled by user'
                    task['progress'] = 0
                else:
                    task['status'] = 'completed' if success else 'failed'
                    task['message'] = message
                    task['progress'] = 100 if success else 0

            except DownloadManager._Cancelled:
                print(f"Task cancelled: {task.get('model_id')}")
                task['status'] = 'cancelled'
                task['message'] = 'Cancelled by user'
                task['progress'] = 0
            except Exception as e:
                # A downloader-level abort counts as a user cancel, not a crash.
                from sdcodex.downloader import CancelledError as _DlCancelled

                if isinstance(e, _DlCancelled) or task.get('cancel'):
                    print(f"Task cancelled: {task.get('model_id')}")
                    task['status'] = 'cancelled'
                    task['message'] = 'Cancelled by user'
                    task['progress'] = 0
                else:
                    print(f"Worker error: {e}")
                    import traceback

                    traceback.print_exc()
                    task['status'] = 'failed'
                    task['message'] = str(e)
                    task['progress'] = 0
            finally:
                self._finish(task)
                try:
                    self.queue.task_done()
                except ValueError:
                    pass

# Global instance
download_manager = DownloadManager()

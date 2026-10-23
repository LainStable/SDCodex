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


def remove_missing_downloads(found_ids: set, scanned_types: set, scanned_dirs=()) -> int:
    """Delete library rows that vanished from *scanned* categories only.

    A type-filtered scan must never delete rows belonging to categories it did
    not walk (that was silently wiping the rest of the library). Rows whose
    file lives outside the directories actually walked (unmounted path,
    unreadable subtree) are kept too.
    """
    from sdcodex.models import Download

    if not scanned_types:
        return 0
    roots = []
    for directory in scanned_dirs or ():
        try:
            roots.append(os.path.realpath(directory))
        except OSError:
            continue
    removed = 0
    for download in Download.query.all():
        if download.type not in scanned_types:
            continue
        if (download.model_id, download.version_id) in found_ids:
            continue
        if roots:
            model_path = (download.get_files() or {}).get("model") or ""
            if not model_path:
                continue
            real = os.path.realpath(model_path)
            if not any(os.path.commonpath((real, root)) == root for root in roots):
                continue
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
            # (model_id, version_id) -> task dict parked by the user.
            cls._instance.paused = {}
            cls._instance.app = app
            cls._instance.running = False
            cls._instance.lock = threading.Lock()
            cls._instance.workers = 0
            cls._instance._worker_threads = []
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
            if not hasattr(self, '_worker_threads'):
                self._worker_threads = []
            self._worker_threads = [t for t in self._worker_threads if t.is_alive()]
            self.workers = len(self._worker_threads)
            while self.workers < limit:
                self.workers += 1
                thread = threading.Thread(target=self._worker_wrapper, daemon=True)
                self._worker_threads.append(thread)
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
        from sdcodex.scanner import identify_unmatched, scan_directory

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
                        if task.get("type") == "identify":
                            _, message, _ = identify_unmatched(task["api_key"], progress_callback)
                        else:
                            only = task.get("model_types") or None
                            dir_rows = {
                                s.key: (s.value or "").strip()
                                for s in Setting.query.all()
                                if s.key.startswith("dir_") and (s.value or "").strip()
                            }
                            directories = []
                            configured_counts = {}
                            for m_type in MODEL_TYPES:
                                if only and m_type not in only:
                                    continue
                                paths = [dir_rows[f"dir_{m_type}"]] if f"dir_{m_type}" in dir_rows else []
                                extra = sorted(
                                    v for k, v in dir_rows.items() if k.startswith(f"dir_{m_type}__")
                                )
                                configured_counts[m_type] = sum(1 for p in paths + extra if p)
                                for path in paths + extra:
                                    # Skip paths that are currently unreachable
                                    # (unmounted drive, typo): their rows must not
                                    # be treated as missing and deleted.
                                    if os.path.isdir(path):
                                        directories.append((path, m_type))
                            scanned_counts = {}
                            for _, m_type in directories:
                                scanned_counts[m_type] = scanned_counts.get(m_type, 0) + 1
                            # Only prune categories whose every configured path
                            # was actually scanned; an unmounted/renamed folder
                            # must never delete the rows it still owns.
                            prunable_types = {
                                m_type
                                for m_type, total in configured_counts.items()
                                if total and scanned_counts.get(m_type, 0) >= total
                            }
                            total_updated = 0
                            all_found_ids = set()
                            for directory, m_type in directories:
                                task['message'] = f"Scanning {m_type} directory..."
                                updated, msg, found_ids = scan_directory(
                                    directory, m_type, task['api_key'], progress_callback
                                )
                                total_updated += updated
                                all_found_ids.update(found_ids)
                            removed_count = remove_missing_downloads(
                                all_found_ids,
                                prunable_types,
                                [directory for directory, _ in directories],
                            )
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

    @staticmethod
    def _new_task(model_id=None, version_id=None, api_key=None, task_type='download', **kwargs):
        return {
            'type': task_type,
            'model_id': model_id,
            'version_id': version_id,
            'api_key': api_key,
            'status': 'queued',
            'progress': 0,
            'message': 'Queued',
            **kwargs,
        }

    def add_task(self, model_id=None, version_id=None, api_key=None, task_type='download', **kwargs):
        task = self._new_task(model_id, version_id, api_key, task_type, **kwargs)
        self.scan_queue.put(task) if task_type in ('scan', 'identify') else self.queue.put(task)
        try:
            self.ensure_scan_worker()
            if task_type != 'scan':
                self.ensure_workers()
        except Exception:
            pass
        return task

    def cancel_task(self, model_id=None, version_id=None) -> tuple[bool, str]:
        """Remove a queued or paused download, or flag a running one to abort."""
        with self.lock:
            for t in list(self.active_tasks):
                if t.get('model_id') == model_id and t.get('version_id') == version_id:
                    t['cancel'] = True
                    return True, "Cancelling…"
            # A parked (paused) task has no thread watching it — drop it here
            # or it would outlive the queue row the user just removed.
            parked = self.paused.pop((model_id, version_id), None)
        if parked:
            parked['status'] = 'cancelled'
            parked['message'] = 'Cancelled by user'
            self._record_history(parked)
            return True, "Removed from queue."
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

    def cancel_scans(self) -> int:
        """Cancel queued/running scan and identify tasks. Returns the count."""
        count = 0
        with self.lock:
            for t in self.active_tasks:
                if t.get('type') in ('scan', 'identify') and t.get('status') == 'running':
                    t['cancel'] = True
                    t['message'] = 'Cancelling…'
                    count += 1
        kept = []
        try:
            while True:
                t = self.scan_queue.get_nowait()
                if t.get('type') in ('scan', 'identify'):
                    t['status'] = 'cancelled'
                    t['message'] = 'Cancelled by user'
                    self._record_history(t)
                    count += 1
                else:
                    kept.append(t)
        except queue.Empty:
            pass
        for t in kept:
            self.scan_queue.put(t)
        return count

    def get_status(self):
        try:
            if not self.queue.empty():
                self.ensure_workers()
        except Exception:
            pass
        with self.lock:
            active = list(self.active_tasks)
            recent_history = list(self.history[-5:])
            # A longer slice so the queue UI can tell "finished earlier" apart
            # from "never reached the worker" before re-staging anything.
            history = list(self.history[-50:])
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
            'queued_tasks': self._queue_snapshot(),
            'paused_tasks': [
                {
                    'type': t.get('type'),
                    'model_id': t.get('model_id'),
                    'version_id': t.get('version_id'),
                    'status': 'paused',
                    'progress': t.get('progress', 0),
                    'message': t.get('message', 'Paused by user'),
                }
                for t in list(self.paused.values())
            ],
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
            'history': [
                {
                    'type': t.get('type'),
                    'model_id': t.get('model_id'),
                    'version_id': t.get('version_id'),
                    'status': t.get('status'),
                    'progress': t.get('progress', 0),
                    'message': t.get('message', ''),
                }
                for t in history
            ],
        }
        return status

    # ── Queue control ──────────────────────────────────────────────────────
    # The queue lives in memory, so tasks can be parked (paused) and resumed
    # without losing their definition. `force` starts bypass the worker pool so
    # a single download runs immediately even when every slot is busy.

    @staticmethod
    def _task_key(task):
        return (task.get('model_id'), task.get('version_id'))

    def _find_active(self, key):
        with self.lock:
            for t in self.active_tasks:
                if self._task_key(t) == key:
                    return t
        return None

    def _pull_queued(self, key=None):
        """Drain the queue and return matching tasks (all when key is None)."""
        taken, kept = [], []
        try:
            while True:
                t = self.queue.get_nowait()
                if key is None or self._task_key(t) == key:
                    taken.append(t)
                else:
                    kept.append(t)
        except queue.Empty:
            pass
        for t in kept:
            self.queue.put(t)
        return taken

    def _queue_snapshot(self):
        """Cheap read of what is waiting (drained then restored in place)."""
        tasks = self._pull_queued(None)
        for t in tasks:
            self.queue.put(t)
        return [
            {
                'type': t.get('type'),
                'model_id': t.get('model_id'),
                'version_id': t.get('version_id'),
                'status': t.get('status', 'queued'),
                'progress': t.get('progress', 0),
                'message': t.get('message', 'Queued'),
            }
            for t in tasks
        ]

    def _park(self, task, message='Paused by user'):
        with self.lock:
            if task in self.active_tasks:
                self.active_tasks.remove(task)
            self._sync_current()
            task.pop('cancel', None)
            task.pop('pause_requested', None)
            task['status'] = 'paused'
            task['message'] = message
            self.paused[self._task_key(task)] = task

    def pause_task(self, model_id, version_id):
        key = (model_id, version_id)
        active = self._find_active(key)
        if active and active.get('type') != 'scan':
            active['pause_requested'] = True
            active['cancel'] = True
            active['message'] = 'Pausing…'
            return True, 'Pausing…'
        taken = self._pull_queued(key)
        if not taken:
            if key in self.paused:
                return True, 'Already paused.'
            return False, 'Task not found.'
        task = taken[0]
        for extra in taken[1:]:
            self.queue.put(extra)
        self._park(task)
        return True, 'Paused.'

    def pause_all(self):
        count = 0
        with self.lock:
            active = [t for t in self.active_tasks if t.get('type') != 'scan']
        for t in active:
            t['pause_requested'] = True
            t['cancel'] = True
            t['message'] = 'Pausing…'
            count += 1
        for t in self._pull_queued(None):
            if t.get('type') == 'scan':
                self.scan_queue.put(t)
                continue
            self._park(t)
            count += 1
        return count

    def start_task(self, model_id, version_id, api_key=None, force=True):
        """Resume or (re)start a download.

        `force=True` runs it on a dedicated thread immediately, even when the
        configured parallel limit is already saturated."""
        key = (model_id, version_id)
        with self.lock:
            running = next((t for t in self.active_tasks if self._task_key(t) == key), None)
            paused = self.paused.pop(key, None)
        if running:
            running.pop('pause_requested', None)
            running['cancel'] = False
            return True, 'Already running.', running
        queued = self._pull_queued(key)
        if queued:
            task = queued[0]
            for extra in queued[1:]:
                self.queue.put(extra)
        elif paused:
            task = paused
        else:
            task = self._new_task(model_id, version_id, api_key)
        task['status'] = 'queued'
        task['message'] = 'Queued'
        task['progress'] = 0
        task.pop('cancel', None)
        task.pop('pause_requested', None)
        if not force:
            self.queue.put(task)
            try:
                self.ensure_workers()
            except Exception:
                pass
            return True, 'Queued behind running downloads.', task
        with self.lock:
            self.active_tasks.append(task)
            self._sync_current()
        task['status'] = 'running'
        task['message'] = 'Starting…'
        threading.Thread(target=self._run_task, args=(task,), daemon=True).start()
        return True, 'Starting now — past the parallel limit.', task

    def start_all(self, api_key=None, force=True):
        with self.lock:
            parked = list(self.paused.values())
        started = 0
        for task in parked:
            ok, _msg, _task = self.start_task(
                task.get('model_id'), task.get('version_id'), api_key or task.get('api_key'), force
            )
            if ok:
                started += 1
        return started

    def _run_task(self, task):
        """Execute one task; the caller owns active_tasks bookkeeping."""
        try:
            print(f"Worker picked up task: {task.get('type', 'download')} - {task.get('model_id')}")
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

            if task.get('pause_requested'):
                task['status'] = 'paused'
                task['message'] = 'Paused by user'
            elif task.get('cancel'):
                task['status'] = 'cancelled'
                task['message'] = 'Cancelled by user'
                task['progress'] = 0
            else:
                task['status'] = 'completed' if success else 'failed'
                task['message'] = message
                task['progress'] = 100 if success else 0

        except DownloadManager._Cancelled:
            print(f"Task cancelled: {task.get('model_id')}")
            task['status'] = 'paused' if task.get('pause_requested') else 'cancelled'
            task['message'] = 'Paused by user' if task.get('pause_requested') else 'Cancelled by user'
            if task['status'] == 'cancelled':
                task['progress'] = 0
        except Exception as e:
            # A downloader-level abort counts as a user cancel, not a crash.
            from sdcodex.downloader import CancelledError as _DlCancelled

            if task.get('pause_requested'):
                task['status'] = 'paused'
                task['message'] = 'Paused by user'
            elif isinstance(e, _DlCancelled) or task.get('cancel'):
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
            if task.get('status') == 'paused':
                self._park(task)
            else:
                self._finish(task)

    def _worker_wrapper(self):
        try:
            self._worker()
        finally:
            with self.lock:
                if hasattr(self, '_worker_threads'):
                    self._worker_threads = [t for t in self._worker_threads if t.is_alive()]
                    self.workers = len(self._worker_threads)

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
                with self.lock:
                    self.active_tasks.append(task)
                    self._sync_current()
                self._run_task(task)
            finally:
                try:
                    self.queue.task_done()
                except ValueError:
                    pass


# Global instance
download_manager = DownloadManager()

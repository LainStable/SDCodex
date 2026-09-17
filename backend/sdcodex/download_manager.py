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

class DownloadManager:
    _instance = None

    def __new__(cls, app=None):
        if cls._instance is None:
            cls._instance = super(DownloadManager, cls).__new__(cls)
            cls._instance.queue = queue.Queue()
            cls._instance.current_task = None
            cls._instance.active_tasks = []
            cls._instance.history = []
            cls._instance.app = app
            cls._instance.running = False
            cls._instance.lock = threading.Lock()
            cls._instance.workers = 0
        return cls._instance

    def init_app(self, app):
        self.app = app
        self.start()

    def max_workers(self):
        """Parallel download limit (Setting max_parallel_downloads, default 1)."""
        try:
            from sdcodex.models import Setting

            with self.app.app_context():
                row = db.session.get(Setting, "max_parallel_downloads")
                return max(1, min(8, int(row.value or 1)))
        except Exception:
            return 1

    def start(self):
        if not self.running:
            self.running = True
            self.ensure_workers()

    def ensure_workers(self):
        """Top up worker threads to the configured parallelism."""
        with self.lock:
            while self.workers < self.max_workers():
                self.workers += 1
                thread = threading.Thread(target=self._worker, daemon=True)
                thread.start()

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
        self.queue.put(task)
        try:
            self.ensure_workers()
        except Exception:
            pass
        return task

    def get_status(self):
        with self.lock:
            active = list(self.active_tasks)
        status = {
            'current_task': self.current_task,
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
            'recent_history': self.history[-5:] if self.history else []
        }
        return status

    def _worker(self):
        print("DownloadManager worker started")
        while True:
            try:
                # Scale down when the limit was lowered: idle extras exit here.
                with self.lock:
                    if self.workers > self.max_workers() and self.queue.empty():
                        self.workers -= 1
                        print("DownloadManager worker exiting (limit lowered)")
                        return
                try:
                    task = self.queue.get(timeout=2)
                except queue.Empty:
                    continue
                print(f"Worker picked up task: {task.get('type', 'download')} - {task.get('model_id')}")
                self.current_task = task
                with self.lock:
                    self.active_tasks.append(task)
                task['status'] = 'running'
                task['message'] = 'Starting...'
                
                def progress_callback(percentage, msg=None):
                    task['progress'] = percentage
                    if msg:
                        task['message'] = msg
                    else:
                        task['message'] = f"Processing... {percentage}%"

                # Use app context for DB access
                with self.app.app_context():
                    print("Worker entering app context")
                    if task.get('type') == 'scan':
                        from sdcodex.scanner import scan_directory
                        # Scan all configured directories? Or specific one?
                        # Implementation plan said iterate over all.
                        # Let's assume the task contains the list of directories or we fetch them here.
                        # Better to fetch here to be fresh.
                        from sdcodex.models import Setting

                        total_updated = 0
                        directories = []
                        only = task.get("model_types") or None
                        # All dir settings, so one type can map several folders:
                        # dir_<Type>, dir_<Type>__1, dir_<Type>__2, ...
                        dir_rows = {
                            s.key: (s.value or "").strip()
                            for s in Setting.query.all()
                            if s.key.startswith("dir_") and (s.value or "").strip()
                        }
                        for m_type in MODEL_TYPES:
                            if only and m_type not in only:
                                continue
                            paths = [dir_rows[f"dir_{m_type}"]] if f"dir_{m_type}" in dir_rows else []
                            extra = sorted(
                                v for k, v in dir_rows.items() if k.startswith(f"dir_{m_type}__")
                            )
                            for path in paths + extra:
                                directories.append((path, m_type))
                        
                        # Fallback default dirs
                        # Actually, if not set, we might not want to scan random places.
                        # But we have defaults in downloader.
                        # Let's stick to configured ones for now, or defaults if we use them.
                        
                        if not directories:
                             # Maybe add defaults?
                             pass

                        count = 0
                        total_dirs = len(directories)
                        all_found_ids = set()
                        
                        for i, (directory, m_type) in enumerate(directories):
                            task['message'] = f"Scanning {m_type} directory..."
                            updated, msg, found_ids = scan_directory(directory, m_type, task['api_key'], progress_callback)
                            total_updated += updated
                            all_found_ids.update(found_ids)
                        
                        # Cleanup missing models
                        from sdcodex.models import Download
                        all_downloads = Download.query.all()
                        removed_count = 0
                        for download in all_downloads:
                            if (download.model_id, download.version_id) not in all_found_ids:
                                db.session.delete(download)
                                removed_count += 1
                        
                        if removed_count > 0:
                            db.session.commit()
                        
                        success = True
                        message = f"Scan complete. Updated {total_updated} models. Removed {removed_count} missing models."
                        
                    else:
                        # Normal download
                        success, message = download_model(
                            task['model_id'], 
                            task['version_id'], 
                            task['api_key'], 
                            progress_callback
                        )
                    
                    print(f"Task finished: {success} - {message}")
                
                task['status'] = 'completed' if success else 'failed'
                task['message'] = message
                task['progress'] = 100 if success else 0

                self.history.append(task)
                with self.lock:
                    if task in self.active_tasks:
                        self.active_tasks.remove(task)
                if self.current_task is task:
                    self.current_task = None
                self.queue.task_done()

            except Exception as e:
                print(f"Worker error: {e}")
                import traceback
                traceback.print_exc()
                if self.current_task:
                    self.current_task['status'] = 'failed'
                    self.current_task['message'] = str(e)
                    self.history.append(self.current_task)
                    with self.lock:
                        if self.current_task in self.active_tasks:
                            self.active_tasks.remove(self.current_task)
                    self.current_task = None

# Global instance
download_manager = DownloadManager()

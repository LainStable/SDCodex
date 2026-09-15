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
            cls._instance.history = []
            cls._instance.app = app
            cls._instance.running = False
        return cls._instance

    def init_app(self, app):
        self.app = app
        self.start()

    def start(self):
        if not self.running:
            self.running = True
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
        return task

    def get_status(self):
        status = {
            'current_task': self.current_task,
            'queue_length': self.queue.qsize(),
            'recent_history': self.history[-5:] if self.history else []
        }
        return status

    def _worker(self):
        print("DownloadManager worker started")
        while True:
            try:
                task = self.queue.get()
                print(f"Worker picked up task: {task.get('type', 'download')} - {task.get('model_id')}")
                self.current_task = task
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
                        for m_type in MODEL_TYPES:
                            setting = Setting.query.get(f"dir_{m_type}")
                            if setting and setting.value:
                                directories.append((setting.value, m_type))
                        
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
                    self.current_task = None

# Global instance
download_manager = DownloadManager()

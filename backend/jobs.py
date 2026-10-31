"""Celery jobs for CPU-heavy circuit recognition.

Run a worker from the backend directory with:
    celery -A jobs:celery_app worker --loglevel=info --concurrency=1
"""

import base64
import binascii
import os
import threading
import uuid
from concurrent.futures import Future, ThreadPoolExecutor

try:
    from celery import Celery
except ImportError:  # Local development can use the in-process queue.
    Celery = None


BROKER_URL = os.environ.get("CELERY_BROKER_URL", "redis://localhost:6379/0")
RESULT_BACKEND = os.environ.get("CELERY_RESULT_BACKEND", BROKER_URL)

celery_app = Celery("circuit_jobs", broker=BROKER_URL, backend=RESULT_BACKEND) if Celery else None
if celery_app:
    celery_app.conf.update(
        task_serializer="json",
        accept_content=["json"],
        result_serializer="json",
        result_expires=3600,
        task_track_started=True,
        worker_prefetch_multiplier=1,
    )


def _decode_image(payload: str):
    from recognizer import decode_image

    encoded = payload.split(",", 1)[1] if payload.startswith("data:") else payload
    try:
        data = base64.b64decode(encoded, validate=True)
    except binascii.Error as exc:
        raise ValueError("Image is not valid base64.") from exc
    return decode_image(data)


def run_generation(payload: dict) -> dict:
    """Run detection, topology extraction and optional OCR outside FastAPI."""
    from recognizer import box_from_json, recognize

    image = _decode_image(payload["image"])
    detections = payload.get("detections")
    boxes = None
    if detections is not None:
        try:
            boxes = [box_from_json(item) for item in detections]
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("Malformed detections.") from exc
    return recognize(
        image,
        title=payload.get("title", "drawn-circuit"),
        boxes=boxes,
        ocr=payload.get("ocr", True),
    )


generate_circuit_job = (
    celery_app.task(name="circuit.generate", acks_late=True)(run_generation)
    if celery_app else None
)


_local_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="circuit-inference")
_local_jobs: dict[str, Future] = {}
_local_lock = threading.Lock()


def submit_local(payload: dict) -> str:
    """Submit a development job without Redis or a separate worker."""
    job_id = uuid.uuid4().hex
    future = _local_executor.submit(run_generation, payload)
    with _local_lock:
        _local_jobs[job_id] = future
    return job_id


class LocalResult:
    def __init__(self, future: Future | None):
        self.future = future

    @property
    def state(self) -> str:
        if self.future is None or not self.future.running() and not self.future.done():
            return "PENDING"
        if self.future.running():
            return "STARTED"
        return "FAILURE" if self.future.exception() is not None else "SUCCESS"

    @property
    def result(self):
        if self.future is None or not self.future.done():
            return None
        error = self.future.exception()
        return error if error is not None else self.future.result()


def get_local_job(job_id: str) -> LocalResult:
    with _local_lock:
        return LocalResult(_local_jobs.get(job_id))

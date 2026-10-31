"""Celery jobs for CPU-heavy circuit recognition.

Two queues keep the live preview responsive:
  * ``detect``   - YOLO-only detection for the drawing preview (fast, small).
  * ``generate`` - full recognition: detection, wire topology and OCR (slow).

Run the workers from the backend directory with:
    celery -A jobs:celery_app worker -Q generate --concurrency=3 --loglevel=info
    celery -A jobs:celery_app worker -Q detect   --concurrency=1 --loglevel=info
On Windows, add ``--pool=solo`` (and use one process per queue).
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

GENERATE_QUEUE = "generate"
DETECT_QUEUE = "detect"
# A preview older than this is useless (the user has kept drawing), so a
# backed-up detect queue drops it instead of working through stale images.
DETECT_EXPIRES_S = float(os.environ.get("CIRCUIT_DETECT_EXPIRES", "10"))

celery_app = Celery("circuit_jobs", broker=BROKER_URL, backend=RESULT_BACKEND) if Celery else None
if celery_app:
    celery_app.conf.update(
        task_serializer="json",
        accept_content=["json"],
        result_serializer="json",
        result_expires=3600,
        task_track_started=True,
        worker_prefetch_multiplier=1,
        task_routes={
            "circuit.generate": {"queue": GENERATE_QUEUE},
            "circuit.detect": {"queue": DETECT_QUEUE},
        },
    )

    from celery.signals import worker_process_init

    @worker_process_init.connect
    def _warm_up_detector(**_kwargs) -> None:
        """Load YOLO in each worker process so its first job isn't slow."""
        try:
            import numpy as np
            from recognizer import detect_boxes
            detect_boxes(np.full((320, 320, 3), 255, np.uint8))
        except Exception as exc:  # warm-up is best effort
            print(f"[jobs] detector warm-up skipped: {exc}")


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


def run_detection(payload: dict) -> dict:
    """YOLO component detection only (the drawing preview)."""
    from recognizer import box_to_json, detect_boxes

    image = _decode_image(payload["image"])
    h, w = image.shape[:2]
    return {
        "image_width": w, "image_height": h,
        "detections": [box_to_json(b) for b in detect_boxes(image)],
    }


generate_circuit_job = (
    celery_app.task(name="circuit.generate", acks_late=True)(run_generation)
    if celery_app else None
)

# Not acks_late: a lost preview is simply re-requested by the next stroke.
detect_components_job = (
    celery_app.task(name="circuit.detect")(run_detection)
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

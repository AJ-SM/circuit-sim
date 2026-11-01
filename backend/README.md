# circuit-backend

Python/FastAPI backend for the circuit simulator. Accepts JSON netlists from the frontend, builds SPICE decks, runs them via **ngspice**, and returns DC operating-point results (branch currents, node voltages).

> Full reference for every route, the YOLO model and the drawing-recognition pipeline: **[BACKEND_SUMMARY.md](BACKEND_SUMMARY.md)**.

## Prerequisites

| Dependency | Install |
|---|---|
| Python ≥ 3.11 | https://python.org |
| Redis | local package or `docker run --rm -p 6379:6379 redis:7-alpine` |
| ngspice | `winget install ngspice` **or** https://ngspice.sourceforge.io |
| pip packages | `pip install -r requirements.txt` |

> **Windows ngspice tip**: If `ngspice` is not on PATH after installation, set the env var:
> ```
> $env:NGSPICE_PATH = "C:\Program Files\Spice64\bin\ngspice.exe"
> ```

## Running

### Docker deployment

From this `backend` directory on a Linux VPS with Docker Compose installed:

```sh
docker compose build
docker compose up -d
docker compose ps
curl http://localhost:18080/health
```

Compose runs the API, a `generate` worker (full recognition + OCR, 3 processes;
set `GENERATE_CONCURRENCY` to change), a `detect` worker (live-preview detection
only; `DETECT_CONCURRENCY`), and Redis. It builds the
`circuit-sim-backend:latest` image from the Dockerfile, including ngspice and
the bundled model weights. Set `API_PORT` to change the host port (default:
`18080`). Redis stores queued jobs in a persistent Docker volume. The worker
downloads OCR models on first use and keeps them in the
`ocr-cache` Docker volume. Allow enough disk space and RAM for Python, PyTorch,
PaddleOCR, and the downloaded models.

For an API-only image build, run `docker build -t circuit-sim-backend:latest .`
from this directory. The frontend needs its API URLs set to the VPS origin
before its production build.

On Windows, `powershell -ExecutionPolicy Bypass -File .\build-image.ps1` builds
the Linux amd64 image and saves `circuit-sim-backend-linux-amd64.tar` in this
directory for copying. On the VPS, load it with
`docker load -i circuit-sim-backend-linux-amd64.tar`.

```powershell
cd circuit-backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

For production, set `$env:CIRCUIT_QUEUE_MODE = "celery"`, then start Redis and
the two inference workers in more terminals:

```powershell
docker run --rm -p 6379:6379 redis:7-alpine
celery -A jobs:celery_app worker -Q generate -n generate@%h --loglevel=info --pool=solo
celery -A jobs:celery_app worker -Q detect -n detect@%h --loglevel=info --pool=solo
```

On Linux, drop `--pool=solo` and use `--concurrency=3` for the `generate`
worker. In celery mode `/detect-components` runs on the `detect` queue and the
API process loads no models.

The server starts at **http://localhost:8000**.

## API

### `POST /simulate`

**Request body** (mirrors what the frontend already sends):

```json
{
  "netlist": {
    "version": 1,
    "components": [
      { "id": "...", "ref": "R1", "type": "resistor",   "nodes": ["1","0"], "params": {"resistance": 1000} },
      { "id": "...", "ref": "V1", "type": "vsource_dc", "nodes": ["1","0"], "params": {"voltage": 5} }
    ],
    "nets": ["0","1"]
  },
  "analysis": { "mode": "dc", "tran": { "stepSeconds": 1e-6, "stopSeconds": 1e-3 }, "ac": { "startHz": 1, "stopHz": 1e6, "pointsPerDecade": 20 } }
}
```

**Response**:

```json
{
  "ok": true,
  "traces": {
    "I(V1)": [-0.005],
    "V(1)":  [5.0]
  }
}
```

Current values are also **console-logged in Amperes** by the server.

### `GET /health`

Returns `{ "status": "ok" }`.

### `POST /generate-circuit`

Turns an image of a hand-drawn circuit (the frontend's **✎ Draw Circuit** canvas) into a netlist using the YOLO pipeline in the bundled `model/` folder.

**Request**: `{ "image": "data:image/png;base64,...", "title": "drawn-circuit" }`

**Response** (`202`): `{ "job_id": "...", "status": "queued" }`.

Poll `GET /job/{job_id}/status`. When it returns `complete`, fetch
`GET /job/{job_id}/result` for the netlist JSON. Recognition errors are
returned by the result endpoint with status `422`.

| Env var | Default |
|---|---|
| `CIRCUIT_MODEL_DIR` | `./model` |
| `CIRCUIT_MODEL_WEIGHTS` | `$CIRCUIT_MODEL_DIR/circuit_yolo11_best.pt` |
| `CELERY_BROKER_URL` | `redis://localhost:6379/0` |
| `CELERY_RESULT_BACKEND` | broker URL |
| `CIRCUIT_QUEUE_MODE` | `local` (`celery` for Redis/Celery workers) |

Component values are filled in with defaults (1k, 10u, DC 5, ...). You can edit them afterwards in the properties panel.

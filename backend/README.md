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

```powershell
cd circuit-backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

For production, set `$env:CIRCUIT_QUEUE_MODE = "celery"`, then start Redis and
the inference worker in two more terminals:

```powershell
docker run --rm -p 6379:6379 redis:7-alpine
celery -A jobs:celery_app worker --loglevel=info --concurrency=1 --pool=solo
```

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
| `CIRCUIT_MODEL_WEIGHTS` | `$CIRCUIT_MODEL_DIR/circuit_detector_v2_best.pt` |
| `CELERY_BROKER_URL` | `redis://localhost:6379/0` |
| `CELERY_RESULT_BACKEND` | broker URL |
| `CIRCUIT_QUEUE_MODE` | `local` (`celery` for Redis/Celery workers) |

Component values are filled in with defaults (1k, 10u, DC 5, ...). You can edit them afterwards in the properties panel.

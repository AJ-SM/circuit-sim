# circuit-sim

Draw or upload a circuit, turn it into a netlist with a YOLO model, and simulate it with ngspice.

```
circuit-sim/
├── backend/            FastAPI server (port 8000)
│   ├── main.py         routes: /health, /simulate, /detect-components, /generate-circuit
│   ├── recognizer.py   image -> netlist JSON (YOLO + wire topology)
│   ├── drawn_topology.py, value_reader.py
│   ├── requirements.txt
│   └── model/          bundled pipeline modules + weights (circuit_detector_v2_best.pt)
└── frontend/           Vite + React + TypeScript app "NETSCOPE" (port 5173)
```

Deeper docs: `backend/README.md`, `backend/BACKEND_SUMMARY.md`, `frontend/README.md`, and `docs/` (e.g. `docs/component-placement.md`: how parts are positioned on the canvas).

## Prerequisites

| Tool | Needed for |
|------|-----------|
| Python 3.10+ | backend |
| Redis | inference job queue and results |
| Node.js 18+ and npm | frontend |
| ngspice on `PATH` (or `NGSPICE_PATH` set) | `/simulate` only. Not needed for drawing or image recognition |

## Run it (humans)

Local development uses an in-process background queue, so only the API and
frontend are required. Redis and Celery are used for production deployments.

**1. Backend**
```
cd backend
pip install -r requirements.txt
python -m uvicorn main:app --port 8000
```
Check it: open http://localhost:8000/health. It should return `{"status":"ok"}`.

**2. Production queue and inference worker (optional locally)**
```
docker run --rm -p 6379:6379 redis:7-alpine
cd backend
celery -A jobs:celery_app worker -Q generate -n generate@%h --loglevel=info --concurrency=3
celery -A jobs:celery_app worker -Q detect -n detect@%h --loglevel=info --concurrency=1
```
Run the two workers in separate terminals and set `CIRCUIT_QUEUE_MODE=celery`
for the API. The `generate` worker does full recognition and OCR; the `detect`
worker does only the live-preview detection, so previews never wait behind
OCR jobs. On Windows, add `--pool=solo` to each Celery command. The worker downloads and
loads the PaddleOCR PP-OCRv4 models on its first OCR job.

**3. Frontend**
```
cd frontend
npm install
npm run dev
```
Open the URL Vite prints, usually http://localhost:5173. If that port is taken, Vite picks the next one, such as 5174. The backend allows any origin, so this works.

Use it: place parts from the left palette, or click **Draw Circuit** to sketch a circuit and press **Generate Circuit**. **Load Image** and **Load Netlist** are also available. **Simulate** runs ngspice.

## Run it (agents)

Commands are non-interactive and have a clear success signal.

```
# backend (background it; stays running)
cd backend && python -m uvicorn main:app --port 8000
# ready when: curl -s localhost:8000/health  ->  {"status":"ok"}

# Redis and worker (run as separate background processes)
docker run --rm -p 6379:6379 redis:7-alpine
cd backend && celery -A jobs:celery_app worker -Q generate -n generate@%h --loglevel=info --concurrency=3
cd backend && celery -A jobs:celery_app worker -Q detect -n detect@%h --loglevel=info --concurrency=1

# frontend dev server (background it)
cd frontend && npm install && npm run dev -- --port 5173
# Vite prints the real URL. If the port is busy it silently moves to the next one, so read its output.

# frontend verification without a browser
cd frontend && npm run build        # runs tsc -b + vite build; exit 0 = typecheck and build OK
cd frontend && npm run lint         # oxlint
```

Test `/generate-circuit` from the command line. It takes JSON with a base64 image, **not** a multipart file upload:
```python
import base64, json, urllib.request
img = base64.b64encode(open("some_circuit.jpg", "rb").read()).decode()
req = urllib.request.Request("http://localhost:8000/generate-circuit",
    json.dumps({"image": img, "title": "test"}).encode(),
    {"Content-Type": "application/json"})
queued = json.load(urllib.request.urlopen(req))
print(queued)  # {"job_id": "...", "status": "queued"}
```
Poll `/job/{job_id}/status`, then fetch `/job/{job_id}/result` when complete.
`/simulate` takes a body with `netlist` and `analysis` fields (see `backend/main.py`).

Stop servers when done. On Windows, find the PID with `netstat -ano | findstr :8000` and run `taskkill /F /PID <pid>`.

## Configuration

| Variable | Where | Default |
|----------|-------|---------|
| `CIRCUIT_MODEL_DIR` | backend | `backend/model` |
| `CIRCUIT_MODEL_WEIGHTS` | backend | `$CIRCUIT_MODEL_DIR/circuit_detector_v2_best.pt` |
| `NGSPICE_PATH` | backend | `ngspice` on `PATH` |
| `CELERY_BROKER_URL` | backend + worker | `redis://localhost:6379/0` |
| `CELERY_RESULT_BACKEND` | backend + worker | broker URL |
| `CIRCUIT_QUEUE_MODE` | backend | `local`; set to `celery` in production |
| `VITE_SIMULATE_URL` | frontend (`.env`) | `http://localhost:8000/simulate` |
| `VITE_GENERATE_URL` | frontend (`.env`) | `http://localhost:8000/generate-circuit` |

If the backend runs on another port or host, copy `frontend/.env.example` to `frontend/.env` and edit the two URLs.

## Troubleshooting

- **Frontend says it can't reach the backend:** confirm `/health` works and that the `VITE_*` URLs match the backend port.
- **`/simulate` fails:** ngspice isn't installed or isn't on `PATH`.
- **Generation stays queued:** start Redis and the Celery worker, then check the worker log.
- **`ModuleNotFoundError` on `/generate-circuit`:** run `pip install -r requirements.txt` in both the API and worker environment.
- **Slow first detection:** the model is loaded on first use. Later calls are faster.

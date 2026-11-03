# Smartyfyp — Production Architecture for 5,000 Colleges

> **Product in one sentence**: A web-based smartboard platform that turns a professor's live drawings, speech, and uploads into structured notes + interactive circuit simulations — accessible to every student, from any device, forever.

---

## 1. Scale Reality Check

Before choosing tech, understand what 5,000 colleges actually means:

| Metric | Estimate |
|---|---|
| Colleges | 5,000 |
| Avg ECE professors per college | 20 |
| Avg class size | 60 students |
| Peak concurrent lecture sessions | ~2,000 (10% at same time) |
| Peak concurrent users (prof + students) | ~2,000 × 61 = **~122,000** |
| YOLO/OCR inference jobs per day | ~40,000 (professors drawing circuits) |
| ngspice simulation jobs per day | ~500,000 (students tweaking values) |
| Stored lecture pages per year | ~5,000 colleges × 20 profs × 100 lectures = **10 million** |
| Stored images/PDFs per year | ~50 million files |

**Critical insight**: The AI inference (YOLO + OCR + speech-to-text + LLM note structuring) is expensive and slow. It cannot be synchronous in a web request. Everything AI must go through an async job queue.

---

## 2. High-Level Architecture

```
                        ┌─────────────────────────────┐
                        │     Cloudflare (CDN + WAF)  │
                        └──────────────┬──────────────┘
                                       │
              ┌────────────────────────▼─────────────────────────┐
              │                 API Gateway (Kong)                │
              │      Rate limiting · Auth · Routing · Logging     │
              └──┬──────────┬──────────┬──────────┬──────────────┘
                 │          │          │          │
          ┌──────▼──┐ ┌─────▼───┐ ┌───▼────┐ ┌──▼───────┐
          │  Auth   │ │Lecture  │ │Sim     │ │Real-time │
          │Service  │ │Service  │ │Service │ │ Service  │
          │(Node.js)│ │(FastAPI)│ │(FastAPI│ │(Node.js/ │
          │         │ │         │ │+queue) │ │ Socket.io│
          └──────┬──┘ └─────┬───┘ └───┬────┘ └──┬───────┘
                 │          │          │          │
          ┌──────▼──────────▼──────────▼──────────▼──────┐
          │                    Redis                       │
          │   Sessions · Pub/Sub · Job Queue · Cache       │
          └───────────────────┬───────────────────────────┘
                              │
          ┌───────────────────▼───────────────────────────┐
          │              PostgreSQL (Primary)              │
          │         + Read Replicas per region            │
          └───────────────────────────────────────────────┘
                              │
          ┌───────────────────▼───────────────────────────┐
          │            AI Worker Cluster (GPU)             │
          │    YOLO · OCR · Whisper STT · LLM notes       │
          │          (Celery + Redis queue)                │
          └───────────────────────────────────────────────┘
                              │
          ┌───────────────────▼───────────────────────────┐
          │          Simulation Worker Cluster (CPU)       │
          │        ngspice batch · result caching          │
          │          (Celery + Redis queue)                │
          └───────────────────────────────────────────────┘
                              │
          ┌───────────────────▼───────────────────────────┐
          │                 Object Storage                 │
          │      S3/GCS: images, PDFs, lecture assets     │
          └───────────────────────────────────────────────┘
```

---

## 3. Full Tech Stack

### 3.1 Frontend

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 15** (App Router) | SSR for lecture pages (SEO, shareable links), ISR for archived lectures, React for the canvas |
| Language | **TypeScript** | Already in use; keep it |
| State | **Zustand** | Already in use; keep it |
| Canvas/Editor | **Tldraw** (open-source whiteboard SDK) | Production-grade infinite canvas, already handles strokes, shapes, freehand — replace the current custom canvas. Has a React component. |
| Real-time | **Socket.io client** | Students see professor's strokes live |
| HTTP client | **TanStack Query (React Query)** | Server state, loading/error states, caching, background refetch |
| Styling | **Tailwind CSS** | Scalable design system at team level |
| Component library | **shadcn/ui** | Headless, accessible, built on Radix |
| Math rendering | **KaTeX** | Render LaTeX formulas from structured notes inline |
| Auth | **NextAuth.js** (or Clerk) | OAuth SSO with college Identity Providers (SAML/OIDC), JWT |
| Bundler | **Vite** (for dev) / **Next.js built-in** (for prod) | — |
| Testing | **Vitest** + **Playwright** | Unit + E2E |

> **Keep from current**: Zustand store shape, `buildNetlist()` union-find logic, `SchematicCanvas` SVG layer (embed inside Tldraw as a custom shape), wire routing logic, `WireView`, `ComponentView`, `AnalysisOverlay`.

---

### 3.2 Backend — Microservices

Split the current monolithic `main.py` into focused services. All communicate over HTTP internally, orchestrated by the API Gateway.

#### Service 1: Auth Service
- **Runtime**: Node.js + Express (or NestJS)
- **Responsibility**: JWT issue/refresh, SSO federation (SAML for colleges), role management (Professor / Student / Admin / Institution Admin)
- **Library**: Passport.js with SAML strategy, or delegate entirely to **Auth0** / **Clerk** (recommended at scale)

#### Service 2: Lecture Service
- **Runtime**: **FastAPI** (Python) — familiar, extend existing backend
- **Responsibility**: CRUD for lectures, notes, circuits; presigned S3 upload URLs; lecture sharing/permissions; version history
- **DB**: PostgreSQL (primary)

#### Service 3: AI Service (GPU workers)
- **Runtime**: **FastAPI** + **Celery** workers on GPU instances
- **Responsibility**:
  - YOLO circuit detection (existing model — keep `recognizer.py`)
  - OCR value reading (existing `value_reader.py`)
  - **Whisper** (OpenAI) speech-to-text transcription
  - **LLM** (GPT-4o / Gemini 2.5 / Claude) for: note structuring, solve-for-unknown, formula extraction
- **Queue**: Redis (Celery broker + result backend)
- **Scaling**: Auto-scale GPU pods based on queue depth (Kubernetes HPA)

#### Service 4: Simulation Service
- **Runtime**: **FastAPI** + **Celery** workers on CPU instances
- **Responsibility**: Build SPICE deck, run `ngspice -b`, parse results, return `branch_analysis`
- **Optimization**: Cache simulation results by netlist hash in Redis (same circuit = cached result, no re-run)
- **Queue**: Redis (separate queue from AI)
- **Isolation**: Each ngspice subprocess runs in its own Docker container via job spawning — no shared state, no interference

#### Service 5: Real-time Service
- **Runtime**: **Node.js** + **Socket.io** + Redis adapter
- **Responsibility**: 
  - Push professor strokes to student browsers (sub-100ms)
  - Broadcast simulation results to all students in a lecture
  - Presence (who's in the session)
- **Scaling**: Multiple Socket.io instances coordinated via **Redis pub/sub**

#### Service 6: Storage Service (thin wrapper)
- **Runtime**: FastAPI
- **Responsibility**: Generate presigned S3 URLs, handle image/PDF uploads, thumbnails
- **Storage**: **AWS S3** or **Google Cloud Storage**

---

### 3.3 Data Layer

| Store | Technology | Used for |
|---|---|---|
| Primary DB | **PostgreSQL 16** (RDS / Cloud SQL) | Colleges, users, lectures, circuits, notes, permissions |
| Read replicas | **PostgreSQL read replicas** | Student reads (lecture content, simulation history) |
| Cache + Queue | **Redis 7** (ElastiCache / Upstash) | Sessions, API cache, Celery broker, Socket.io pub/sub, sim result cache |
| Object storage | **AWS S3** (or GCS) | Images, PDFs, audio files, lecture thumbnails |
| Search | **PostgreSQL full-text** (start here) → **Meilisearch** (when needed) | Lecture search, note search |
| Time-series (optional) | **InfluxDB** or **TimescaleDB** | Simulation result timeseries for transient analysis plots |

#### PostgreSQL Schema (core tables)
```sql
institutions     -- college/university (tenant root)
users            -- professors & students, linked to institution
courses          -- e.g. "EE201 – Circuit Analysis"
lectures         -- one per class session, belongs to a course
lecture_blocks   -- ordered blocks: text | circuit | image | formula
circuits         -- netlist JSON + simulation results, belongs to a lecture_block
simulation_jobs  -- queue tracking: pending | running | done | failed
ai_jobs          -- same for YOLO/OCR/STT/LLM tasks
```

---

### 3.4 AI Pipeline (the hard part)

```
Professor draws / speaks / uploads
          │
          ▼
  [Real-time Service]
  Stroke events → broadcast to students immediately
          │
          ▼ (async, off the hot path)
  [AI Job Queue (Redis)]
          │
    ┌─────▼──────────────────────────────────────────┐
    │              GPU Worker (Celery)                │
    │                                                  │
    │  1. YOLO detect components  ← recognizer.py    │
    │  2. drawn_topology.py → wire graph             │
    │  3. value_reader.py (EasyOCR + TrOCR)          │
    │  4. Whisper STT (if audio)                     │
    │  5. LLM: structure notes, extract formulas     │
    │  6. LLM: solve-for-unknown (if requested)      │
    └────────────────────────────────┬───────────────┘
                                     │
                          result pushed via WebSocket
                                     │
                          Students see structured notes
                          + schematic appears on canvas
                                     │
                          Student tweaks a value
                                     │
                    [Simulation Job Queue (Redis)]
                                     │
                      CPU Worker: ngspice -b → result
                      (cached by netlist hash)
                                     │
                          Result pushed via WebSocket
                          All students see updated values
```

---

### 3.5 Infrastructure & DevOps

| Layer | Choice | Why |
|---|---|---|
| Container | **Docker** | Each service + worker in its own image |
| Orchestration | **Kubernetes** (EKS / GKE) | Auto-scale AI workers on queue depth; scale sim workers on load |
| API Gateway | **Kong** (self-hosted) or **AWS API Gateway** | Rate limiting per institution, auth, routing |
| CDN | **Cloudflare** | Static assets, lecture thumbnails, DDoS protection |
| CI/CD | **GitHub Actions** | Test → Build → Push image → Rolling deploy to K8s |
| IaC | **Terraform** | Reproducible infra across envs |
| Secrets | **AWS Secrets Manager** / **HashiCorp Vault** | API keys, DB credentials |
| Monitoring | **Prometheus + Grafana** | Service health, queue depth, GPU utilization |
| Error tracking | **Sentry** | Frontend and backend errors |
| Logging | **ELK Stack** (Elasticsearch + Logstash + Kibana) or **Datadog** | Centralized logs |
| APM | **Datadog** or **OpenTelemetry** | Distributed tracing across services |

---

### 3.6 Multi-Tenancy Model

Each institution is a **tenant**. Isolation strategy: **shared DB, Row-Level Security (RLS)**.

```sql
-- Every row in every table carries institution_id
-- PostgreSQL RLS enforces that queries only see rows for the current tenant
ALTER TABLE lectures ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lectures
  USING (institution_id = current_setting('app.institution_id')::uuid);
```

**Subdomain routing**: `mit.smartyfyp.com`, `iit.smartyfyp.com`
→ API Gateway extracts subdomain → sets `institution_id` in request context
→ All downstream services respect it

**SSO**: Colleges use their existing LDAP/SAML identity provider.
Auth service federates via SAML 2.0 / OIDC. No new passwords.

---

## 4. Migration Path from Current Codebase

Don't rewrite everything. Migrate in phases.

### Phase 1 — Productionize the core (Month 1–2)
- [ ] Wrap existing `main.py` in Docker, push to container registry
- [ ] Add PostgreSQL (replace in-memory state)
- [ ] Add Redis for Celery; move YOLO inference to async job
- [ ] Add auth (JWT) to all routes
- [ ] Deploy to a single K8s cluster (even a small one)
- [ ] Add institution + user tables, basic multi-tenancy

### Phase 2 — Frontend upgrade (Month 2–3)
- [ ] Migrate Vite+React → Next.js 15 (keep all component logic)
- [ ] Embed `SchematicCanvas` as a Tldraw custom shape
- [ ] Add Socket.io for real-time stroke broadcast
- [ ] TanStack Query for all API calls
- [ ] SSO login page (Google OAuth first, SAML later)

### Phase 3 — AI pipeline (Month 3–5)
- [ ] Add Whisper STT worker
- [ ] Add LLM note-structuring worker (GPT-4o or Gemini)
- [ ] Add solve-for-unknown endpoint
- [ ] Real-time AI result push via WebSocket

### Phase 4 — Scale hardening (Month 5–6)
- [ ] K8s HPA on AI worker queue depth
- [ ] Simulation result caching by netlist hash
- [ ] CDN for all static + lecture assets
- [ ] Monitoring, alerting, SLO dashboards
- [ ] Load testing (k6) to 122,000 concurrent users

### Phase 5 — Institution onboarding (Month 6+)
- [ ] Institution admin portal
- [ ] SAML SSO federation per college
- [ ] Usage analytics per institution
- [ ] Billing / SLA tiers

---

## 5. Cost Estimate (rough, AWS)

| Component | Instance type | Count | $/month |
|---|---|---|---|
| API / services | t3.medium | 6 | ~$300 |
| PostgreSQL RDS | db.r6g.large + 2 replicas | 3 | ~$900 |
| Redis ElastiCache | cache.r6g.large | 2 | ~$400 |
| AI GPU workers | g4dn.xlarge (T4 GPU) | 4 (auto-scaled) | ~$1,200 |
| Sim CPU workers | c6i.2xlarge | 6 (auto-scaled) | ~$700 |
| S3 storage (50M files) | S3 Standard | — | ~$1,200 |
| Cloudflare Pro | — | — | ~$200 |
| Sentry + Datadog | — | — | ~$500 |
| **Total** | | | **~$5,400/month** |

At 5,000 colleges × $X/college/year → break even at ~$13/college/year.
Realistic pricing: $500–$2,000/college/year → healthy margin.

---

## 6. What You Keep From the Existing Codebase

| Current file | Fate |
|---|---|
| `recognizer.py` | ✅ Keep — wrap in Celery worker |
| `drawn_topology.py` | ✅ Keep |
| `value_reader.py` | ✅ Keep |
| `model/*.py` + `.pt` weights | ✅ Keep |
| `main.py` /simulate route | ✅ Keep — extract to Sim Service |
| `frontend/src/domain/netlist.ts` | ✅ Keep |
| `frontend/src/canvas/*` | ✅ Keep — embed in Next.js |
| `frontend/src/store/circuitStore.ts` | ✅ Keep — add socket sync |
| `frontend/src/domain/currentFlow.ts` | ✅ Keep |
| Vite config, CSS tokens | ⚙️ Migrate to Next.js + Tailwind |
| `main.py` /generate-circuit (sync HTTP) | ⚙️ Refactor to async job |

---

## 7. The Critical Non-Obvious Decisions

### ngspice is the bottleneck
ngspice is a single-threaded, process-spawned binary. At 500,000 sim jobs/day:
- Average job: ~200ms → need ~1,160 concurrent ngspice processes
- **Solution**: Pool of simulation workers, each running one ngspice at a time. Cache results by SHA-256 of the sorted netlist JSON. Most students run the same circuit → ~70% cache hit rate → real load ~350 jobs/sec → 12 workers handle it.

### Tldraw as the canvas foundation
The current custom `SchematicCanvas` is good but will need years of work to match a production whiteboard (touch, stylus, undo, collaborative cursors, lasso, etc.). Tldraw is open-source, MIT-licensed, and handles all of this. Your NETSCOPE schematic layer becomes a **Tldraw custom shape** that renders the SVG schematic inside Tldraw's infinite canvas.

### LLM cost is the biggest variable
LLM note structuring at scale:
- 40,000 lectures/day × ~2,000 tokens/lecture = 80M tokens/day
- GPT-4o at $5/1M tokens input → ~$400/day → ~$12,000/month
- **Mitigation**: Use Gemini Flash (cheaper), cache structured notes, only run LLM once per unique lecture block (not per student view)

### Simulation isolation is a security requirement
Students will eventually find malicious SPICE inputs. Every ngspice process must run inside a **restricted Docker container** (no network, read-only filesystem, CPU/memory limits, 30s timeout). The current subprocess call is fine locally but must be sandboxed at scale.

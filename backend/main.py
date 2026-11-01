"""
circuit-backend/main.py
========================
Single-route FastAPI server that accepts a resistive-circuit netlist,
writes a SPICE deck, runs it through ngspice (batch/console mode), parses
the output, and returns branch currents (in Amperes).

Run:
    uvicorn main:app --reload --port 8000

Prerequisites:
    pip install fastapi uvicorn
    ngspice must be on PATH.
    On Windows (Chocolatey install) the console binary is ngspice_con.exe —
    this is detected automatically. You can also set NGSPICE_PATH env var.
"""

import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="Circuit Simulator Backend")


@app.on_event("startup")
def _warm_up_models() -> None:
    """Warm the models used in-process (local mode only).

    In celery mode the API runs no inference at all: detection runs on the
    `detect` worker and full recognition + OCR on the `generate` workers,
    so the API keeps no copy of YOLO or PaddleOCR in memory.
    """
    import threading

    if os.environ.get("CIRCUIT_QUEUE_MODE", "local").lower() == "celery":
        return

    def load() -> None:
        try:
            import numpy as np
            import recognizer
            import value_reader
            value_reader.warm_up()
            recognizer.detect_boxes(np.full((320, 320, 3), 255, np.uint8))
            print("[circuit-backend] detection model loaded")
        except Exception as exc:
            print(f"[circuit-backend] model warm-up skipped: {exc}")

    threading.Thread(target=load, daemon=True).start()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

class NetlistComponent(BaseModel):
    id: str
    ref: str
    type: str
    nodes: list[str]
    params: dict[str, float]

class Netlist(BaseModel):
    version: int
    components: list[NetlistComponent]
    nets: list[str]

class TransientConfig(BaseModel):
    stepSeconds: float
    stopSeconds: float

class AcConfig(BaseModel):
    startHz: float
    stopHz: float
    pointsPerDecade: int

class Analysis(BaseModel):
    mode: str
    tran: TransientConfig | None = None
    ac: AcConfig | None = None

class SimulateRequest(BaseModel):
    netlist: Netlist
    analysis: Analysis

class BranchInfo(BaseModel):
    component_id: str
    ref: str
    type: str
    node_a: str
    node_b: str
    voltage_a: float
    voltage_b: float
    delta_v: float
    current_a: float
    direction: str
    # Every pin, in the component's pin order: its net, its voltage and the
    # current flowing INTO the part at that pin. For two-pin parts this is
    # [current_a, -current_a]; transistors and op-amps need it because their
    # pin currents differ (Ie = Ic + Ib; an op-amp's output current comes
    # from its supply, which the drawing doesn't show).
    pin_nodes: list[str] | None = None
    pin_voltages: list[float] | None = None
    pin_currents: list[float] | None = None

class SimulationResult(BaseModel):
    ok: bool
    message: str | None = None
    traces: dict[str, list[float]] | None = None
    branch_analysis: list[BranchInfo] | None = None

_TYPE_TO_SPICE = {
    "resistor":   "R",
    "capacitor":  "C",
    "inductor":   "L",
    "vsource_dc": "V",
    "vsource_ac": "V",
    "battery":    "V",
    "vsource_dep": "V",
    "diode":      "D",
    "bjt_npn":    "Q",
    "bjt_pnp":    "Q",
    "opamp":      "B",
    "ground":     None,
}
_VOLTAGE_SOURCES = {"vsource_dc", "vsource_ac", "battery", "vsource_dep"}

# Parts with more than two pins: their pin names, in the frontend's pin
# order (nodes[i] is pin i). The first two are the pair that node_a/node_b,
# delta_v and current_a describe: collector-emitter (Vce, Ic) for a
# transistor, the inputs (differential input voltage) for an op-amp.
_MULTI_PIN = {
    "bjt_npn": ("C", "E", "B"),
    "bjt_pnp": ("C", "E", "B"),
    "opamp":   ("INP", "INN", "OUT"),
}

class _Deck:
    """A SPICE deck plus the names needed to read each component's result.

    Every element gets an index-based SPICE name (V0_V1, R2_R1, ...), so two
    parts that share a ref - the DC and AC source palettes both number from
    V1 - can't clash. Each passive part also gets a 0 V sense source in
    series, so ngspice reports the true current through it (capacitors and
    inductors included) as `<sense>#branch`, positive from pin A to pin B.
    Transistors and op-amps get a sense source on every pin instead
    (`pins`), each positive for current flowing into the part."""
    def __init__(self) -> None:
        self.text = ""
        # component index -> (branch vector name, is_voltage_source)
        self.branch: dict[int, tuple[str, bool]] = {}
        # component index -> sense source per pin (multi-pin parts only)
        self.pins: dict[int, list[str]] = {}
        self.nodes: list[str] = []
        self.ac_freq: float | None = None

    def vectors(self) -> list[str]:
        names = [br for br, _ in self.branch.values()]
        names += [s for senses in self.pins.values() for s in senses if s not in names]
        return [f"v({n})" for n in self.nodes] + [f"{s}#branch" for s in names]


def _spice_name(prefix: str, idx: int, ref: str) -> str:
    return f"{prefix}{idx}_{re.sub(r'[^A-Za-z0-9]', '', ref) or 'X'}"


def _add_multi_pin(lines: list[str], models: list[str], deck: _Deck, idx: int,
                   comp: NetlistComponent, prefix: str, node, nodes: set[str]) -> None:
    """Emit a transistor or op-amp. Each pin connects through a 0 V sense
    source (outer net -> inner node), so `<sense>#branch` is the current
    flowing into the part at that pin."""
    pin_names = _MULTI_PIN[comp.type]
    outer = [node(n) for n in comp.nodes[:len(pin_names)]]
    nodes.update(outer)
    inner = [f"s{idx}_{k}" for k in range(len(pin_names))]
    senses = [f"VS{idx}_{k}" for k in range(len(pin_names))]
    for o, i, s in zip(outer, inner, senses):
        lines.append(f"{s} {o} {i} 0")
    name = _spice_name(prefix, idx, comp.ref)
    p = comp.params

    if comp.type in ("bjt_npn", "bjt_pnp"):
        c, e, b = inner
        model = f"QM{idx}"
        beta = p.get("beta", 100) or 100
        polarity = "NPN" if comp.type == "bjt_npn" else "PNP"
        lines.append(f"{name} {c} {b} {e} {model}")
        # A generic small-signal transistor (2N3904/2N3906 class): IS sets
        # Vbe ~ 0.65 V at 1 mA, VAF a mild Early effect.
        models.append(f".model {model} {polarity}(IS=1e-14 BF={beta:g} BR=1 VAF=100)")
    else:  # opamp
        inp, inn, out = inner
        gain = p.get("gain", 1e5) or 1e5
        vpos, vneg = p.get("vpos", 15), p.get("vneg", -15)
        if vpos < vneg:
            vpos, vneg = vneg, vpos
        if vpos - vneg < 1e-3:
            vpos, vneg = vpos + 0.5, vneg - 0.5
        vmid, vhalf = (vpos + vneg) / 2, (vpos - vneg) / 2
        # Ideal op-amp with output limits: linear with open-loop gain `gain`
        # around zero input, saturating smoothly at the rails (so an
        # open-loop comparator stops at the rail instead of 1e5 * Vin).
        # The output is referenced to ground; its current comes from the
        # supply, which is not drawn.
        lines.append(f"R{idx}_in {inp} {inn} 10Meg")
        lines.append(f"{name} {out} 0 V={vmid:g}+{vhalf:g}*tanh({gain:g}*(v({inp})-v({inn}))/{vhalf:g})")

    # node_a/node_b of the branch analysis are pins 0 and 1; current_a is
    # the current into pin 0.
    deck.branch[idx] = (senses[0].lower(), False)
    deck.pins[idx] = [s.lower() for s in senses]


def _build_spice_deck(netlist: Netlist, ac_freq: float | None) -> _Deck:
    """Build the deck. With `ac_freq`, a single-frequency AC analysis at that
    frequency gives the sinusoidal steady state; otherwise the DC operating
    point is solved."""
    # Any net touching a GND component is SPICE's reference node "0".
    gnd_nets: set[str] = set()
    for comp in netlist.components:
        if comp.type == "ground":
            gnd_nets.update(comp.nodes)

    def _node(n: str) -> str:
        return "0" if n in gnd_nets else n

    deck = _Deck()
    deck.ac_freq = ac_freq
    lines: list[str] = ["* Auto-generated by circuit-backend"]
    nodes: set[str] = set()
    uses_diode = False
    models: list[str] = []
    for idx, comp in enumerate(netlist.components):
        prefix = _TYPE_TO_SPICE.get(comp.type)
        if prefix is None or len(comp.nodes) < 2:
            continue
        if comp.type in _MULTI_PIN:
            if len(comp.nodes) < len(_MULTI_PIN[comp.type]):
                continue
            _add_multi_pin(lines, models, deck, idx, comp, prefix, _node, nodes)
            continue
        a, b = _node(comp.nodes[0]), _node(comp.nodes[1])
        nodes.update((a, b))
        name = _spice_name(prefix, idx, comp.ref)
        p = comp.params
        if comp.type in _VOLTAGE_SOURCES:
            if comp.type == "vsource_ac":
                # The editor stores the AC source's peak as "amplitude".
                v = p.get("amplitude", p.get("voltage", 1))
                freq = p.get("frequency", 50)
                lines.append(f"{name} {a} {b} DC 0 AC {v} SIN(0 {v} {freq})")
            else:
                lines.append(f"{name} {a} {b} DC {p.get('voltage', 5)}")
            deck.branch[idx] = (name.lower(), True)
            continue
        sense_node = f"s{idx}"
        sense = f"VS{idx}"
        if comp.type == "resistor":
            lines.append(f"{name} {a} {sense_node} {p.get('resistance', 1000) or 1000}")
        elif comp.type == "capacitor":
            lines.append(f"{name} {a} {sense_node} {p.get('capacitance', 1e-6)}")
        elif comp.type == "inductor":
            lines.append(f"{name} {a} {sense_node} {p.get('inductance', 1e-3)}")
        elif comp.type == "diode":
            lines.append(f"{name} {a} {sense_node} DMOD")
            uses_diode = True
        lines.append(f"{sense} {sense_node} {b} 0")
        deck.branch[idx] = (sense.lower(), False)
    if uses_diode:
        lines.append(".model DMOD D(IS=2.52n RS=0.568 N=1.752)")
    lines.extend(models)

    deck.nodes = sorted(n for n in nodes if n != "0")
    vectors = deck.vectors()
    lines.append(".control")
    lines.append("set numdgt=12")    # print enough digits for exact KCL / power balance
    if ac_freq is None:
        lines.append("op")
        cmd = " ".join(vectors)
    else:
        lines.append(f"ac lin 1 {ac_freq} {ac_freq}")
        cmd = " ".join(f"real({v}) imag({v})" for v in vectors)
    lines.append("echo RESULTS_BEGIN")
    if cmd:
        lines.append(f"print {cmd}")
    lines.append("echo RESULTS_END")
    lines.append(".endc")
    lines.append(".end")
    deck.text = "\n".join(lines)
    return deck

def _find_ngspice() -> str:
    """Return the path to the ngspice console/batch binary.

    Priority:
      1. NGSPICE_PATH environment variable (explicit override)
      2. ngspice_con  – Windows Chocolatey installs the headless binary here
      3. ngspice      – standard PATH name on Linux/macOS and some Windows builds
    """
    env_path = os.environ.get("NGSPICE_PATH")
    if env_path:
        return env_path
    # On Windows, prefer the console (non-GUI) variant installed by Chocolatey
    if os.name == "nt":
        for candidate in ("ngspice_con", "ngspice"):
            try:
                result = subprocess.run(
                    [candidate, "-v"],
                    capture_output=True, timeout=5,
                )
                return candidate          # found and runnable
            except FileNotFoundError:
                continue
    return "ngspice"

NGSPICE = _find_ngspice()
print(f"[circuit-backend] Using ngspice binary: {NGSPICE!r}")

def _run_ngspice(spice_deck: str) -> str:
    with tempfile.NamedTemporaryFile(mode="w", suffix=".cir", delete=False, encoding="utf-8") as f:
        f.write(spice_deck)
        cir_path = f.name
    try:
        result = subprocess.run(
            [NGSPICE, "-b", cir_path],
            capture_output=True, text=True, timeout=30,
        )
        return result.stdout + result.stderr
    finally:
        Path(cir_path).unlink(missing_ok=True)

# `print` of single-point vectors gives one `name = value` line per vector.
_PRINT_LINE_RE = re.compile(
    r"^\s*([^\s=]+)\s*=\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*$",
    re.MULTILINE,
)

def _parse_results(raw: str, deck: _Deck) -> dict[str, complex] | None:
    """Vector name (lower-case, e.g. 'v(1)', 'vs3#branch') -> value. DC values
    come back as real numbers, AC values as complex phasors. None when
    ngspice didn't produce every value (e.g. a singular circuit)."""
    start = raw.find("RESULTS_BEGIN")
    end = raw.find("RESULTS_END", start)
    if start < 0 or end < 0:
        return None
    printed = {m.group(1).lower(): float(m.group(2))
               for m in _PRINT_LINE_RE.finditer(raw[start:end])}
    values: dict[str, complex] = {}
    for v in deck.vectors():
        if deck.ac_freq is None:
            if v not in printed:
                return None
            values[v] = complex(printed[v], 0.0)
        else:
            re_v, im_v = printed.get(f"real({v})"), printed.get(f"imag({v})")
            if re_v is None or im_v is None:
                return None
            values[v] = complex(re_v, im_v)
    return values


def _signed(z: complex) -> float:
    """Collapse a phasor to one signed number for display: its magnitude,
    signed by the in-phase (real) part relative to the source - or by the
    quadrature part when it is almost purely reactive. DC values pass through."""
    mag = abs(z)
    if mag == 0:
        return 0.0
    ref = z.real if abs(z.real) > 1e-6 * mag else z.imag
    return mag if ref >= 0 else -mag


def _compute_branch_analysis(netlist: Netlist, deck: _Deck, values: dict[str, complex]) -> list[dict]:
    """
    Per-component branch analysis using standard EE conventions:

    1. Node voltages are relative to ground (node "0" = 0 V).
    2. Small numerical noise near zero is clamped to 0 V.
    3. One sign convention for every part (passive sign convention):
       delta_v = V(node_a) - V(node_b), and current_a is the conventional
       current flowing THROUGH the part from pin a to pin b (positive a->b).
       Passive parts read it from their series sense source.
    4. Voltage sources use the same convention: ngspice's v#branch is
       already the current through the source from + (pin a) to - (pin b).
       A source delivering power therefore reports a negative current
       (direction b_to_a: inside the source current rises from - to +, and
       it leaves the + terminal into the circuit).
    5. AC (sinusoidal steady state): voltages and currents are peak
       amplitudes; the sign gives the direction relative to the source phase.
    """
    _ZERO_SNAP = 1e-3  # 1 mV: any |V| below this is snapped to 0 V
    _CURRENT_SNAP = 1e-9  # 1 nA: any |I| below this is snapped to 0 A
    gnd_nets = {n for c in netlist.components if c.type == "ground" for n in c.nodes}

    def phasor(node: str) -> complex:
        return 0j if node == "0" or node in gnd_nets else values.get(f"v({node})", 0j)

    def volts(z: complex) -> float:
        # Node potentials: DC keeps its sign; AC shows the amplitude.
        v = z.real if deck.ac_freq is None else abs(z)
        return 0.0 if abs(v) < _ZERO_SNAP else round(v, 6)

    branches: list[dict] = []
    for idx, comp in enumerate(netlist.components):
        if idx not in deck.branch:
            continue
        na, nb = comp.nodes[0].lower(), comp.nodes[1].lower()
        za, zb = phasor(comp.nodes[0]), phasor(comp.nodes[1])
        dv = _signed(za - zb)
        if abs(dv) < _ZERO_SNAP:
            dv = 0.0
        br, _ = deck.branch[idx]
        i = values.get(f"{br}#branch", 0j)
        current = _signed(i)
        # ngspice's GMIN leakage (~1e-12 S per node) shows up as pA "currents"
        # in branches that really carry none (e.g. behind a capacitor at DC).
        if abs(current) < _CURRENT_SNAP:
            current, direction = 0.0, "none"
        else:
            direction = "a_to_b" if current > 0 else "b_to_a"
        if idx in deck.pins:
            pin_nodes = comp.nodes[:len(deck.pins[idx])]
            pin_currents = []
            for s in deck.pins[idx]:
                ip = _signed(values.get(f"{s}#branch", 0j))
                pin_currents.append(0.0 if abs(ip) < _CURRENT_SNAP else round(ip, 12))
        else:
            pin_nodes = comp.nodes[:2]
            pin_currents = [round(current, 12), round(-current, 12) + 0.0]
        branches.append({
            "pin_nodes": [n.lower() for n in pin_nodes],
            "pin_voltages": [volts(phasor(n)) for n in pin_nodes],
            "pin_currents": pin_currents,
            "component_id": comp.id,
            "ref": comp.ref,
            "type": comp.type,
            "node_a": na,
            "node_b": nb,
            "voltage_a": volts(za),
            "voltage_b": volts(zb),
            "delta_v": round(dv, 6),
            "current_a": round(current, 12),
            "direction": direction,
        })
    print("=== Branch analysis ===")
    for b in branches:
        arrow = "a->b" if b["direction"] == "a_to_b" else ("b->a" if b["direction"] == "b_to_a" else " 0 ")
        print(f"  {b['ref']:5s} ({b['type']:12s})  Va={b['voltage_a']:+.3f}V  Vb={b['voltage_b']:+.3f}V  dV={b['delta_v']:+.4f}V  I={b['current_a']:+.6e}A  [{arrow}]")
    print("=======================\n")
    return branches

@app.post("/simulate", response_model=SimulationResult)
async def simulate(req: SimulateRequest) -> Any:
    # A circuit driven by an AC source has no meaningful DC operating point
    # (the source is 0 V at DC), so solve its sinusoidal steady state at the
    # source frequency instead - unless DC analysis was asked for explicitly.
    ac_sources = [c for c in req.netlist.components if c.type == "vsource_ac"]
    ac_freq: float | None = None
    if ac_sources and req.analysis.mode != "dc":
        ac_freq = float(ac_sources[0].params.get("frequency", 50)) or 50.0

    deck = _build_spice_deck(req.netlist, ac_freq)
    print("\n=== SPICE deck ===")
    print(deck.text)
    print("==================\n")
    try:
        raw_output = _run_ngspice(deck.text)
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail=f"ngspice not found at '{NGSPICE}'. Install ngspice and make sure it is on your PATH, or set the NGSPICE_PATH environment variable.")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="ngspice timed out.")
    print("=== ngspice raw output ===")
    print(raw_output)
    print("==========================\n")
    values = _parse_results(raw_output, deck)
    if values is None:
        errors = [ln.strip() for ln in raw_output.splitlines() if "error" in ln.lower()]
        detail = "\n".join(errors[:5]) or raw_output[-1500:]
        return SimulationResult(ok=False, message=f"ngspice could not solve this circuit.\n\n{detail}")

    traces: dict[str, list[float]] = {}
    for n in deck.nodes:
        traces[f"V({n.upper()})"] = [_signed(values[f"v({n})"])]
    for idx, (br, _) in deck.branch.items():
        comp = req.netlist.components[idx]
        if idx in deck.pins:
            # One trace per pin, e.g. I(Q1.C), current into the part.
            for pin, s in zip(_MULTI_PIN[comp.type], deck.pins[idx]):
                traces[f"I({comp.ref.upper()}.{pin})"] = [_signed(values[f"{s}#branch"])]
        else:
            traces[f"I({comp.ref.upper()})"] = [_signed(values[f"{br}#branch"])]
    branch_analysis = _compute_branch_analysis(req.netlist, deck, values)

    message = None
    if ac_freq is not None:
        message = f"✓ AC steady state at {ac_freq:g} Hz — values are peak amplitudes"
        if len({c.params.get("frequency", 50) for c in ac_sources}) > 1:
            message += f" (all AC sources solved at {ac_freq:g} Hz)"
        if any(c.type in _VOLTAGE_SOURCES - {"vsource_ac"} for c in req.netlist.components):
            message += "; DC sources are not included"
    return SimulationResult(ok=True, message=message, traces=traces,
                            branch_analysis=[BranchInfo(**b) for b in branch_analysis])

class GenerateCircuitRequest(BaseModel):
    image: str
    title: str = "drawn-circuit"
    # Boxes already found by /detect-components on this exact image (RTP).
    # When given, /generate-circuit reuses them instead of re-running YOLO.
    detections: list[dict[str, Any]] | None = None
    # False: skip reading values/names (fast first pass; defaults are used).
    ocr: bool = True
    # Weights file name from GET /models; None uses the default model.
    model: str | None = None

def _decode_request_image(req: GenerateCircuitRequest):
    import base64
    import binascii
    from recognizer import decode_image
    payload = req.image.split(",", 1)[1] if req.image.startswith("data:") else req.image
    try:
        data = base64.b64decode(payload, validate=True)
    except binascii.Error:
        raise HTTPException(status_code=400, detail="Image is not valid base64.")
    return decode_image(data)

DETECT_TIMEOUT_S = float(os.environ.get("CIRCUIT_DETECT_TIMEOUT", "15"))


def _celery_mode() -> bool:
    return os.environ.get("CIRCUIT_QUEUE_MODE", "local").lower() == "celery"


@app.post("/detect-components")
def detect_components(req: GenerateCircuitRequest) -> dict[str, Any]:
    """Live-preview detection. In celery mode it runs on the dedicated
    `detect` worker queue (so the API process never runs YOLO and previews
    never wait behind slow OCR jobs); the request still returns the boxes
    directly, so the frontend contract is unchanged."""
    if _celery_mode():
        from jobs import DETECT_EXPIRES_S, detect_components_job
        if detect_components_job is None:
            raise HTTPException(status_code=503, detail="Celery is not installed")
        _decode_request_image(req)  # reject bad base64 here with a 400
        try:
            job = detect_components_job.apply_async(
                args=[{"image": req.image, "model": req.model}], expires=DETECT_EXPIRES_S)
        except Exception as exc:
            raise HTTPException(status_code=503,
                                detail="The inference queue is unavailable.") from exc
        try:
            return job.get(timeout=DETECT_TIMEOUT_S)
        except Exception as exc:
            from celery.exceptions import TaskRevokedError, TimeoutError as CeleryTimeout
            if isinstance(exc, (CeleryTimeout, TaskRevokedError)):
                job.forget()
                raise HTTPException(status_code=503,
                                    detail="Detection is busy, try again.") from exc
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    from recognizer import RecognitionError, box_to_json, detect_boxes
    image = _decode_request_image(req)
    try:
        boxes = detect_boxes(image, model=req.model)
    except RecognitionError as e:
        raise HTTPException(status_code=422, detail=str(e))
    h, w = image.shape[:2]
    return {
        "image_width": w, "image_height": h,
        "detections": [box_to_json(b) for b in boxes],
    }

@app.get("/models")
def list_models() -> dict[str, Any]:
    """Detection models the frontend can choose from (.pt files in the
    model folder); `id` is what goes in the request's `model` field."""
    from recognizer import list_models as _list
    return {"models": _list()}


@app.post("/generate-circuit", status_code=status.HTTP_202_ACCEPTED)
def generate_circuit(req: GenerateCircuitRequest) -> dict[str, str]:
    """Queue recognition and return immediately; workers do the CPU work."""
    from jobs import generate_circuit_job, submit_local
    from recognizer import RecognitionError, _resolve_weights

    try:
        _resolve_weights(req.model)  # reject an unknown model with a 400 now
    except RecognitionError as e:
        raise HTTPException(status_code=400, detail=str(e))

    try:
        if os.environ.get("CIRCUIT_QUEUE_MODE", "local").lower() == "celery":
            if generate_circuit_job is None:
                raise RuntimeError("Celery is not installed")
            job_id = generate_circuit_job.delay(req.dict()).id
        else:
            job_id = submit_local(req.dict())
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="The inference queue is unavailable.",
        ) from exc
    return {"job_id": job_id, "status": "queued"}


def _job(job_id: str):
    if os.environ.get("CIRCUIT_QUEUE_MODE", "local").lower() != "celery":
        from jobs import get_local_job
        return get_local_job(job_id)
    from celery.result import AsyncResult
    from jobs import celery_app
    return AsyncResult(job_id, app=celery_app)


@app.get("/job/{job_id}/status")
def job_status(job_id: str) -> dict[str, str]:
    state = _job(job_id).state
    public_state = {
        "PENDING": "queued",
        "RECEIVED": "queued",
        "STARTED": "processing",
        "RETRY": "processing",
        "SUCCESS": "complete",
        "FAILURE": "failed",
        "REVOKED": "failed",
    }.get(state, state.lower())
    return {"job_id": job_id, "status": public_state}


@app.get("/job/{job_id}/result")
def job_result(job_id: str) -> dict[str, Any]:
    job = _job(job_id)
    if job.state == "FAILURE":
        raise HTTPException(status_code=422, detail=str(job.result))
    if job.state != "SUCCESS":
        raise HTTPException(status_code=409, detail="Circuit generation is still in progress.")
    result = job.result
    if not isinstance(result, dict):
        raise HTTPException(status_code=500, detail="The worker returned an invalid result.")
    return result

@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}

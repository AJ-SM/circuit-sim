"""
circuit-backend/recognizer.py
==============================
Runs YOLO component detection from circuitmodel, then derives terminals and
connectivity from the wire ink (drawn_topology.py), then builds the netlist on a single in-memory image and returns the same
netlist JSON dict that `circuit_pipeline.py` writes to netlist.json, so the
frontend's loadNetlistJson() can consume it directly.

The pipeline modules live in the bundled `model/` folder. Its location
defaults to ./model and can be overridden with CIRCUIT_MODEL_DIR.
The weights file defaults to the hand-drawn fine-tuned model and can be
overridden with CIRCUIT_MODEL_WEIGHTS.
"""

import os
import sys
import threading
from pathlib import Path

import cv2
import numpy as np

MODEL_DIR = Path(
    os.environ.get(
        "CIRCUIT_MODEL_DIR",
        Path(__file__).resolve().parent / "model",
    )
)
WEIGHTS = Path(
    # os.environ.get("CIRCUIT_MODEL_WEIGHTS", MODEL_DIR / "circuit_detector_v2_best.pt")
    os.environ.get("CIRCUIT_MODEL_WEIGHTS", MODEL_DIR / "circuit_detector_best.pt")
)

# Same tuning as circuit_pipeline.py
YOLO_CONF       = 0.25
YOLO_IOU        = 0.45
# Extra views for slanted parts (degrees) and the confidence a symbol seen
# only in those views needs to be kept.
ROTATED_VIEWS     = (45, -45)
ROTATED_ONLY_CONF = 0.5
# Only parts people actually draw on a slant are taken from the rotated
# views (rotated canvases make the model see e.g. grounds that aren't there),
# and a rotated view's vote counts for less than the upright one's.
ROTATED_CLASSES   = ("Resistor", "Inductor", "Capacitor", "Diode")
ROTATED_WEIGHT    = 0.5

if str(MODEL_DIR) not in sys.path:
    sys.path.insert(0, str(MODEL_DIR))

_model = None
_model_lock = threading.Lock()


class RecognitionError(Exception):
    pass


def _get_model():
    """Load the YOLO weights once and reuse them across requests."""
    global _model
    with _model_lock:
        if _model is None:
            if not WEIGHTS.exists():
                raise RecognitionError(
                    f"Model weights not found at '{WEIGHTS}'. "
                    "Set CIRCUIT_MODEL_WEIGHTS or CIRCUIT_MODEL_DIR."
                )
            from ultralytics import YOLO
            _model = YOLO(str(WEIGHTS))
        return _model


def decode_image(data: bytes) -> np.ndarray:
    """Decode PNG/JPEG bytes to a BGR image, flattening any alpha onto white
    (canvas exports have a transparent background by default)."""
    buf = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise RecognitionError("Could not decode the uploaded image.")
    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.shape[2] == 4:
        alpha = img[:, :, 3:4].astype(np.float32) / 255.0
        rgb = img[:, :, :3].astype(np.float32)
        img = (rgb * alpha + 255.0 * (1.0 - alpha)).astype(np.uint8)
    return img


def _rotate(image: np.ndarray, angle: float):
    """Rotate about the centre on an expanded canvas filled with the
    background colour. Returns (rotated, inverse 2x3 affine back to image)."""
    h, w = image.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    cos, sin = abs(m[0, 0]), abs(m[0, 1])
    nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
    m[0, 2] += nw / 2 - w / 2
    m[1, 2] += nh / 2 - h / 2
    bg = tuple(int(v) for v in np.median(image.reshape(-1, 3), axis=0))
    rotated = cv2.warpAffine(image, m, (nw, nh), borderValue=bg)
    return rotated, cv2.invertAffineTransform(m)


def _predict(image: np.ndarray, angle: float) -> list[tuple[str, float, np.ndarray]]:
    """(class, conf, 4x2 corner polygon in original image coords) per box."""
    model = _get_model()
    src, inv = (image, None) if angle == 0 else _rotate(image, angle)
    with _model_lock:
        preds = model.predict(source=src, conf=YOLO_CONF, iou=YOLO_IOU, verbose=False)
    out = []
    for box in preds[0].boxes:
        x1, y1, x2, y2 = box.xyxy[0].tolist()
        poly = np.array([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], np.float32)
        if inv is not None:
            poly = (np.hstack([poly, np.ones((4, 1), np.float32)]) @ inv.T).astype(np.float32)
        out.append((model.names[int(box.cls.item())], float(box.conf.item()), poly))
    return out


def _same_symbol(a: np.ndarray, b: np.ndarray) -> bool:
    """Two detections (from any rotation) cover the same drawn symbol."""
    area_a, area_b = cv2.contourArea(a), cv2.contourArea(b)
    small = max(min(area_a, area_b), 1.0)
    if np.hypot(*(a.mean(0) - b.mean(0))) > 0.5 * np.sqrt(small):
        return False
    inter, _ = cv2.intersectConvexConvex(a, b)
    return inter / small > 0.4


def detect_boxes(image: np.ndarray, rotations: bool = True) -> list:
    """YOLO component detection only (no wires, no OCR): fast enough to run
    while the user is still drawing.

    The detector was trained on axis-aligned symbols, so a resistor drawn on
    a slant is often missed, mislabelled (e.g. as a capacitor) or boxed only
    partly. With `rotations`, the image is also run rotated by ±45° — a slanted
    part is upright in one of those views — and detections of the same symbol
    are merged: the class with the most (weighted) confidence wins, and the
    tightest box of that class gives the geometry. A box found in a rotated
    view is returned as its axis-aligned bounds plus `poly`, the oriented
    rectangle around the slanted symbol, which drawn_topology uses instead of
    the bounds so it doesn't cut the wires running past the slanted part."""
    from wire_detector import BoundingBox

    dets = [(*d, 0) for d in _predict(image, 0)]
    if rotations:
        for angle in ROTATED_VIEWS:
            dets += [(*d, angle) for d in _predict(image, angle) if d[0] in ROTATED_CLASSES]

    # Greedy clustering, most confident first.
    clusters: list[list[tuple]] = []
    for det in sorted(dets, key=lambda d: -d[1]):
        for cl in clusters:
            if _same_symbol(cl[0][2], det[2]):
                cl.append(det)
                break
        else:
            clusters.append([det])

    h, w = image.shape[:2]
    boxes: list[BoundingBox] = []
    for cl in clusters:
        # A symbol only the rotated views see needs stronger evidence: the
        # rotated canvases also show things the model was never trained on.
        if all(d[3] != 0 for d in cl) and cl[0][1] < ROTATED_ONLY_CONF:
            continue
        votes: dict[str, float] = {}
        for cls, conf, _, angle in cl:
            votes[cls] = votes.get(cls, 0.0) + conf * (1.0 if angle == 0 else ROTATED_WEIGHT)
        cls = max(votes, key=votes.get)
        members = [d for d in cl if d[0] == cls]
        best_conf = max(d[1] for d in members)
        # Tightest box among confident members of the winning class; ties
        # (within 10 %) go to the upright view.
        members = [d for d in members if d[1] >= 0.6 * best_conf]
        _, conf, poly, angle = min(
            members, key=lambda d: cv2.contourArea(d[2]) * (1.0 if d[3] == 0 else 1.1)
        )
        poly[:, 0] = np.clip(poly[:, 0], 0, w - 1)
        poly[:, 1] = np.clip(poly[:, 1], 0, h - 1)
        x1, y1 = np.floor(poly.min(0)).astype(int)
        x2, y2 = np.ceil(poly.max(0)).astype(int)
        b = BoundingBox(x1=int(x1), y1=int(y1), x2=int(x2), y2=int(y2),
                        cls_name=cls, conf=best_conf)
        if angle != 0:
            b.poly = poly.round().astype(np.int32)
        boxes.append(b)
    return boxes


def box_to_json(b) -> dict:
    """Serialise a detected box for the frontend; `poly` (rotated views only)
    is kept so the box can be sent back to recognize() unchanged."""
    d = {"type": b.cls_name, "conf": round(b.conf, 3),
         "bbox": {"x1": b.x1, "y1": b.y1, "x2": b.x2, "y2": b.y2}}
    poly = getattr(b, "poly", None)
    if poly is not None:
        d["poly"] = poly.tolist()
    return d


def box_from_json(d: dict):
    """Inverse of box_to_json."""
    from wire_detector import BoundingBox
    bb = d["bbox"]
    b = BoundingBox(x1=int(bb["x1"]), y1=int(bb["y1"]), x2=int(bb["x2"]), y2=int(bb["y2"]),
                    cls_name=str(d["type"]), conf=float(d["conf"]))
    if d.get("poly") is not None:
        b.poly = np.asarray(d["poly"], dtype=np.int32).reshape(-1, 2)
    return b


def _rename(components, conn_result, topology, names: dict[str, str]) -> None:
    """Give components their drawn reference designators ({old id: name}).
    Unnamed parts keep their id unless a drawn name took it, in which case
    they get the next free number with the same letter."""
    import re
    from connectivity_graph import PinRef

    if not names:
        return
    taken = set(names.values())
    mapping: dict[str, str] = {}
    for comp in components:
        old = comp.component_id
        if old in names:
            mapping[old] = names[old]
            continue
        new = old
        if new in taken:
            prefix = re.match(r"[A-Za-z]+", old).group(0)
            n = 1
            while f"{prefix}{n}" in taken:
                n += 1
            new = f"{prefix}{n}"
        mapping[old] = new
        taken.add(new)

    for comp in components:
        comp.component_id = mapping[comp.component_id]
    for net in conn_result.nets:
        net.pin_refs = {PinRef(mapping.get(p.component_id, p.component_id), p.pin_name, p.x, p.y)
                        for p in net.pin_refs}
    conn_result.pin_to_net = {
        f"{mapping.get(uid.split('.', 1)[0], uid.split('.', 1)[0])}.{uid.split('.', 1)[1]}": net
        for uid, net in conn_result.pin_to_net.items()
    }
    topology.polarity_method = {mapping.get(k, k): v for k, v in topology.polarity_method.items()}
    # natural order: R2 before R10
    components.sort(key=lambda c: (re.sub(r"\d+", "", c.component_id),
                                   int(re.sub(r"\D", "", c.component_id) or 0)))


def recognize(image: np.ndarray, title: str = "drawn-circuit", boxes: list | None = None) -> dict:
    """Run the full pipeline and return the netlist JSON dict. `boxes` are
    detections already made on this image (run-time processing); when given,
    detection is skipped."""
    from netlist_generator import NetlistGenerator
    from drawn_topology    import DrawnTopology
    from value_reader      import (assign_designators, assign_values, format_spice,
                                   parse_item, read_designators, run_ocr)

    # ── 1. Component detection ──────────────────────────────────
    if boxes is None:
        boxes = detect_boxes(image)

    if not boxes:
        raise RecognitionError(
            "No components were recognised in the drawing. "
            "Try drawing the symbols larger and more clearly."
        )

    # ── 2–4. Terminals + connectivity from the actual wire ink ──
    topology = DrawnTopology(image)
    components, conn_result, dropped = topology.build(boxes)
    if not components:
        raise RecognitionError(
            "Symbols were detected but no wires touch them, so no circuit could "
            "be built. Make sure each wire runs right up to the component ends."
        )

    # ── 5. Labels (OCR; defaults stay if unreadable/unavailable) ──
    # Drawn names ("R5") rename their part, and the value written under a
    # name is that part's value. Parts without a name fall back to the
    # nearest unused value label.
    ocr_items = run_ocr(image)
    designators = read_designators(image, ocr_items)
    named = assign_designators(components, designators)
    _rename(components, conn_result, topology, {cid: d.name for cid, d in named.items()})

    read: dict[str, tuple] = {}
    label_items = set()
    for d in designators:
        label_items.add(id(d.item))
        if d.value is not None:
            label_items.add(id(d.value))
    for comp in components:
        d = next((d for d in named.values() if d.name == comp.component_id), None)
        if d is not None and d.value is not None:
            value, unit, inferred = parse_item(d.value, comp.cls_name)
            if value is not None:
                read[comp.component_id] = (value, unit, inferred)
    rest = [c for c in components if c.component_id not in read]
    read.update(assign_values(rest, [it for it in ocr_items if id(it) not in label_items]))

    # ── 6. Netlist ──
    netlist = NetlistGenerator(interactive=False).generate(
        components, conn_result, title=title
    )
    for entry in netlist.entries:
        if entry.ref_des in read:
            value, unit, _ = read[entry.ref_des]
            entry.value = format_spice(value, unit, entry.cls_name)

    h, w = image.shape[:2]
    netlist.image_width = w
    netlist.image_height = h
    netlist.component_details = []
    for comp in components:
        netlist.component_details.append({
            "ref_des": comp.component_id,
            "type": comp.cls_name,
            "bbox": {
                "x1": comp.box.x1, "y1": comp.box.y1,
                "x2": comp.box.x2, "y2": comp.box.y2,
                "cx": (comp.box.x1 + comp.box.x2) // 2,
                "cy": (comp.box.y1 + comp.box.y2) // 2,
            },
            **({"poly": comp.box.poly.tolist()}
               if getattr(comp.box, "poly", None) is not None else {}),
            "conf": round(comp.box.conf, 3),
            "value_source": (
                "default" if comp.component_id not in read
                else "ocr_inferred" if read[comp.component_id][2]
                else "ocr"
            ),
            **({"polarity": topology.polarity_method[comp.component_id]}
               if comp.component_id in topology.polarity_method else {}),
            "pins": [
                {
                    "name": pin.name,
                    "x": pin.x,
                    "y": pin.y,
                    "net_id": conn_result.pin_to_net.get(f"{comp.component_id}.{pin.name}", "?"),
                }
                for pin in comp.pins
            ],
        })

    result = netlist.to_json_dict()
    # Detections discarded because no wire touches them (usually handwritten
    # labels the detector mistook for parts) — surfaced for debugging.
    result["dropped_detections"] = [
        {"type": d.cls_name, "conf": round(d.conf, 3),
         "bbox": {"x1": d.x1, "y1": d.y1, "x2": d.x2, "y2": d.y2}}
        for d in dropped
    ]
    return result

"""
Draw a placed circuit (the editor's layout) as an image, beside the drawing
it was recognised from, so placement can be checked against the source
without a browser.

Input is the frontend's PlacementSnapshot (src/utils/placementSnapshot.ts):
parts with their pins already resolved to grid positions and wires with
their routed paths, both computed by the canvas's own geometry. This module
only draws them. Each glyph shows the part's orientation: a diode's arrow
points anode -> cathode, a transistor's emitter arrow points out (NPN) or in
(PNP), a source marks its + pin, an op-amp marks + and −, and every pin is
labelled with its name.
"""

from __future__ import annotations

import cv2
import numpy as np

INK = (40, 40, 40)
WIRE = (60, 140, 60)
PART = (170, 60, 30)
PIN = (30, 30, 200)
LABEL = (110, 110, 110)
FONT = cv2.FONT_HERSHEY_SIMPLEX


def _unit(v: np.ndarray) -> np.ndarray:
    n = float(np.hypot(*v))
    return v / n if n else np.array([1.0, 0.0])


def _text(img, s, at, scale=0.4, color=INK, thick=1, centre=True):
    (w, h), _ = cv2.getTextSize(s, FONT, scale, thick)
    x, y = (int(at[0] - w / 2), int(at[1] + h / 2)) if centre else (int(at[0]), int(at[1]))
    cv2.putText(img, s, (x, y), FONT, scale, color, thick, cv2.LINE_AA)


def _arrow(img, a, b, color, size):
    """Filled arrowhead at b, pointing from a to b."""
    u = _unit(b - a)
    n = np.array([-u[1], u[0]])
    pts = np.array([b, b - u * size + n * size * 0.5, b - u * size - n * size * 0.5])
    cv2.fillConvexPoly(img, pts.round().astype(np.int32), color, cv2.LINE_AA)


def _two_pin(img, kind, p1, p2, s):
    """p1/p2: pin positions (px) in the def's pin order."""
    mid = (p1 + p2) / 2
    u = _unit(p2 - p1)
    n = np.array([-u[1], u[0]])
    half = 0.45 * s                                   # body half-length
    a, b = mid - u * half, mid + u * half
    line = lambda q, r, c=PART, t=2: cv2.line(img, tuple(q.round().astype(int)),
                                               tuple(r.round().astype(int)), c, t, cv2.LINE_AA)
    if kind in ("capacitor",):
        line(p1, mid - u * 0.1 * s); line(mid + u * 0.1 * s, p2)
        for c in (mid - u * 0.1 * s, mid + u * 0.1 * s):
            line(c - n * 0.35 * s, c + n * 0.35 * s, t=3)
        return
    if kind == "battery":
        line(p1, mid - u * 0.1 * s); line(mid + u * 0.1 * s, p2)
        line(mid - u * 0.1 * s - n * 0.4 * s, mid - u * 0.1 * s + n * 0.4 * s, t=3)   # + (long)
        line(mid + u * 0.1 * s - n * 0.2 * s, mid + u * 0.1 * s + n * 0.2 * s, t=3)   # − (short)
        return
    line(p1, a); line(b, p2)
    if kind == "resistor":
        box = np.array([a + n * 0.18 * s, b + n * 0.18 * s, b - n * 0.18 * s, a - n * 0.18 * s])
        cv2.polylines(img, [box.round().astype(np.int32)], True, PART, 2, cv2.LINE_AA)
    elif kind == "inductor":
        for k in range(3):
            c = a + u * (k + 0.5) * (2 * half / 3)
            cv2.ellipse(img, tuple(c.round().astype(int)), (int(half / 3), int(half / 3)),
                        float(np.degrees(np.arctan2(u[1], u[0]))), 180, 360, PART, 2, cv2.LINE_AA)
    elif kind == "diode":
        tri = np.array([a + n * 0.3 * s, a - n * 0.3 * s, b])
        cv2.fillConvexPoly(img, tri.round().astype(np.int32), PART, cv2.LINE_AA)
        line(b - n * 0.3 * s, b + n * 0.3 * s, t=3)                                     # cathode bar
    elif kind in ("vsource_dc", "vsource_ac", "vsource_dep"):
        r = int(half)
        cv2.circle(img, tuple(mid.round().astype(int)), r, PART, 2, cv2.LINE_AA)
        _text(img, "+", mid - u * half * 0.5, 0.5, PART, 2)
        _text(img, "~" if kind == "vsource_ac" else "-", mid + u * half * 0.5, 0.5, PART, 2)
    else:
        line(a, b)


def _transistor(img, kind, pins, centre, s):
    c = centre
    cv2.circle(img, tuple(c.round().astype(int)), int(0.75 * s), PART, 2, cv2.LINE_AA)
    base = pins.get("B")
    if base is not None:
        u = _unit(c - base)
        n = np.array([-u[1], u[0]])
        bar = c - u * 0.3 * s
        cv2.line(img, tuple(base.round().astype(int)), tuple(bar.round().astype(int)), PART, 2, cv2.LINE_AA)
        cv2.line(img, tuple((bar - n * 0.45 * s).round().astype(int)),
                 tuple((bar + n * 0.45 * s).round().astype(int)), PART, 3, cv2.LINE_AA)
    else:
        bar = c
    for name in ("C", "E"):
        p = pins.get(name)
        if p is None:
            continue
        side = 1 if p[1] >= bar[1] else -1
        start = bar + np.array([0, side * 0.2 * s]) if base is None else bar + _unit(p - bar) * 0.2 * s
        cv2.line(img, tuple(start.round().astype(int)), tuple(p.round().astype(int)), PART, 2, cv2.LINE_AA)
        if name == "E":
            mid = (start + p) / 2
            if kind == "bjt_npn":
                _arrow(img, start, mid + _unit(p - start) * 0.15 * s, PART, 0.3 * s)
            else:
                _arrow(img, p, mid - _unit(p - start) * 0.15 * s, PART, 0.3 * s)


def _opamp(img, pins, s):
    plus, minus, out = pins.get("+"), pins.get("−", pins.get("-")), pins.get("out")
    if plus is None or minus is None or out is None:
        return
    base_mid = (plus + minus) / 2
    u = _unit(out - base_mid)
    n = np.array([-u[1], u[0]])
    half = max(float(np.hypot(*(plus - minus))) / 2 + 0.5 * s, 0.8 * s)
    b0 = base_mid + u * 0.5 * s
    tri = np.array([b0 + n * half, b0 - n * half, out - u * 0.5 * s])
    cv2.polylines(img, [tri.round().astype(np.int32)], True, PART, 2, cv2.LINE_AA)
    for p in (plus, minus):
        q = p + u * (float(np.dot(b0 - p, u)))
        cv2.line(img, tuple(p.round().astype(int)), tuple(q.round().astype(int)), PART, 2, cv2.LINE_AA)
    cv2.line(img, tuple((out - u * 0.5 * s).round().astype(int)), tuple(out.round().astype(int)), PART, 2, cv2.LINE_AA)
    _text(img, "+", plus + u * 0.95 * s, 0.55, PART, 2)
    _text(img, "-", minus + u * 0.95 * s, 0.55, PART, 2)


def _ground(img, pin, centre, s):
    u = _unit(centre - pin)
    n = np.array([-u[1], u[0]])
    cv2.line(img, tuple(pin.round().astype(int)), tuple(centre.round().astype(int)), PART, 2, cv2.LINE_AA)
    for k, w in enumerate((0.45, 0.3, 0.15)):
        c = centre + u * k * 0.15 * s
        cv2.line(img, tuple((c - n * w * s).round().astype(int)), tuple((c + n * w * s).round().astype(int)),
                 PART, 2, cv2.LINE_AA)


def render_placement(snapshot: dict, source: np.ndarray | None = None, scale: int = 32) -> np.ndarray:
    """BGR image of the placed circuit; with `source`, the source drawing
    on the left at the same height."""
    comps = snapshot.get("components", [])
    wires = snapshot.get("wires", [])
    xs = [p["x"] for c in comps for p in c["pins"]] + [c["x"] for c in comps] + \
         [q["x"] for w in wires for q in w["points"]]
    ys = [p["y"] for c in comps for p in c["pins"]] + [c["y"] for c in comps] + \
         [q["y"] for w in wires for q in w["points"]]
    if not xs:
        xs, ys = [0], [0]
    m = 2                                                  # margin, grid units
    x0, y0 = min(xs) - m, min(ys) - m
    W, H = int((max(xs) - x0 + m) * scale), int((max(ys) - y0 + m) * scale)
    img = np.full((H, W, 3), 255, np.uint8)
    P = lambda x, y: np.array([(x - x0) * scale, (y - y0) * scale], float)

    for gx in range(int(x0), int(x0 + W / scale) + 1):     # grid dots
        for gy in range(int(y0), int(y0 + H / scale) + 1):
            cv2.circle(img, tuple(P(gx, gy).astype(int)), 1, (215, 215, 215), -1)

    for w in wires:
        pts = np.array([P(q["x"], q["y"]) for q in w["points"]]).round().astype(np.int32)
        cv2.polylines(img, [pts], False, WIRE, 2, cv2.LINE_AA)

    for c in comps:
        pins = {p["name"]: P(p["x"], p["y"]) for p in c["pins"]}
        order = [P(p["x"], p["y"]) for p in c["pins"]]
        centre = P(c["x"], c["y"])
        kind = c["kind"]
        if kind in ("bjt_npn", "bjt_pnp"):
            _transistor(img, kind, pins, centre, scale)
        elif kind == "opamp":
            _opamp(img, pins, scale)
        elif kind == "ground" and order:
            _ground(img, order[0], centre, scale)
        elif len(order) >= 2:
            _two_pin(img, kind, order[0], order[1], scale)
        for name, p in pins.items():
            cv2.circle(img, tuple(p.round().astype(int)), 3, PIN, -1, cv2.LINE_AA)
            if kind not in ("ground",) and not (kind in ("resistor", "capacitor", "inductor")):
                # OpenCV's font has no Unicode minus
                lab = {"anode": "a", "cathode": "k", "−": "-"}.get(name, name)
                off = _unit(p - centre) * 0.35 * scale if np.any(p != centre) else np.zeros(2)
                _text(img, lab, p + off + np.array([0, -0.3 * scale]), 0.35, PIN, 1)
        rot = f"{c['ref']}  r{c['rotation']}{' m' if c['mirrored'] else ''}"
        _text(img, rot, centre + np.array([0.0, -1.15 * scale]), 0.38, LABEL, 1)

    if source is None:
        return img
    sh, sw = source.shape[:2]
    k = H / sh
    src = cv2.resize(source, (max(1, int(sw * k)), H), interpolation=cv2.INTER_AREA)
    gap = np.full((H, 12, 3), 200, np.uint8)
    return np.hstack([src, gap, img])

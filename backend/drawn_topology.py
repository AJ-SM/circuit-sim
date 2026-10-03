"""
circuit-backend/drawn_topology.py
==================================
Terminal + connectivity extraction driven by the actual ink, replacing the
circuitmodel stages 2–4 (Hough wire segments, fixed left/right pin guesses,
distance-based pin snapping) for the drawing canvas.

Why: those stages were tuned for ~4000 px photos. On a canvas drawing the
fixed 150 px snap distance merges every pin into one net, and pins are
guessed from the bbox aspect ratio, so e.g. a capacitor drawn as two
horizontal plates (a *wide* box whose leads are top/bottom) gets left/right
pins that touch no wire.

Method:
  1. Binarise the image to an ink mask.
  2. Erase every component box; what's left is wire ink. Close tiny gaps and
     label connected blobs — each blob is one electrical net, junctions and
     corners included, with no distance thresholds between segments.
  3. For each component, look at a thin ring just outside its box. Each
     cluster of wire ink crossing that ring is a real terminal: its position
     gives the pin location (and therefore the part's orientation) and its
     blob gives the net.
  4. Detections that no wire touches (typically handwritten value labels the
     detector mistook for parts) are dropped, and step 2–3 re-run without
     them so their boxes don't cut wires.
"""

from dataclasses import dataclass

import cv2
import numpy as np
from skimage.morphology import skeletonize

from connectivity_graph import ConnectivityResult, Net, PinRef
from terminal_extractor import REFDES_PREFIX, ComponentTerminal, Pin
from wire_detector import BoundingBox

SOURCE_CLASSES = ("Battery", "Voltage", "AC Source")


@dataclass
class _Contact:
    x: float
    y: float
    size: int
    blob: int


def binarize(image: np.ndarray) -> np.ndarray:
    """Ink mask (uint8 0/1). Otsu suits clean canvas exports; for photos with
    uneven lighting, AND it with an adaptive threshold to reject shadows."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    if np.median(gray) < 128:
        # Dark canvas with light strokes: flip so ink is dark, otherwise the
        # dark halo either side of each stroke is taken as ink and every wire
        # splits into two unconnected outlines.
        gray = 255 - gray
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    _, otsu = cv2.threshold(gray, 0, 1, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    block = max(15, (min(gray.shape) // 20) | 1)
    adaptive = cv2.adaptiveThreshold(
        gray, 1, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, block, 10
    )
    clean = float(np.mean(gray > 200)) > 0.6   # mostly white paper/canvas
    return otsu if clean else (otsu & adaptive)


def box_poly(b: BoundingBox) -> np.ndarray:
    """The symbol's outline as an int32 4x2 polygon: the oriented rectangle
    for a part detected on a slant (recognizer sets `poly`), else the box."""
    poly = getattr(b, "poly", None)
    if poly is not None:
        return poly
    return np.array([[b.x1, b.y1], [b.x2, b.y1], [b.x2, b.y2], [b.x1, b.y2]], np.int32)


def dedupe_boxes(boxes: list[BoundingBox]) -> list[BoundingBox]:
    """Class-agnostic suppression: the detector sometimes fires two classes
    on one symbol. Keep the more confident box when two mostly overlap, or
    when they partly overlap and the other is far less confident (e.g. a
    battery's plates also read, weakly, as a ground symbol)."""
    kept: list[BoundingBox] = []
    for b in sorted(boxes, key=lambda b: -b.conf):
        pb = box_poly(b).astype(np.float32)
        area_b = cv2.contourArea(pb)
        dup = False
        for k in kept:
            pk = box_poly(k).astype(np.float32)
            inter, _ = cv2.intersectConvexConvex(pb, pk)
            frac = inter / max(min(area_b, cv2.contourArea(pk)), 1.0)
            if frac > 0.7 or (frac > 0.3 and b.conf < 0.6 * k.conf):
                dup = True
                break
        if not dup:
            kept.append(b)
    return kept


class DrawnTopology:
    def __init__(self, image: np.ndarray):
        self.ink = binarize(image)
        h, w = self.ink.shape
        diag = float(np.hypot(w, h))
        self.ring = max(4, int(diag * 0.006))       # contact band outside a box
        self.gap = max(3, int(diag * 0.004)) | 1    # stroke gaps to close
        self.min_contact = 3
        self.bridge = max(8, int(diag * 0.03))       # max hand-drawn gap between wire ends
        # typical stroke width: twice the median distance-to-background on the skeleton
        skel = skeletonize(self.ink > 0)
        dist = cv2.distanceTransform(self.ink, cv2.DIST_L2, 3)
        self.stroke = max(2.0, 2.0 * float(np.median(dist[skel]))) if skel.any() else 3.0
        # ref_des → how a source's polarity was decided: "marks" | "plates" | "default"
        self.polarity_method: dict[str, str] = {}

    # ── box tightening ────────────────────────────────────────────
    def _tighten(self, box: BoundingBox) -> BoundingBox:
        """Detector boxes are loose, and a loose box erases the wires that
        pass close to the symbol (a junction just past its end, a wire
        running along its side), splitting nets. Pull each edge in while the
        stroke-wide strip along it holds only wire ink (see `wire_only`), at
        most 30 % per side. Slanted (polygon) boxes are already tight;
        grounds keep their box (their bars are short runs that would peel)."""
        if getattr(box, "poly", None) is not None or box.cls_name == "Ground":
            return box
        h, w = self.ink.shape
        x1, y1, x2, y2 = max(box.x1, 0), max(box.y1, 0), min(box.x2, w), min(box.y2, h)
        if x2 - x1 < 8 or y2 - y1 < 8:
            return box
        k = max(1, int(round(self.stroke)))
        short = 3 * self.stroke + k         # a slanted wire widens across the band
        # ink with a k-px margin so the line just outside each edge exists
        pad = np.zeros((y2 - y1 + 2 * k, x2 - x1 + 2 * k), np.uint8)
        sy1, sy2, sx1, sx2 = max(y1 - k, 0), min(y2 + k, h), max(x1 - k, 0), min(x2 + k, w)
        pad[sy1 - (y1 - k):sy2 - (y1 - k), sx1 - (x1 - k):sx2 - (x1 - k)] = self.ink[sy1:sy2, sx1:sx2]

        # Plate symbols: a plate is a long straight run across the leads, so
        # only thin runs (leads) may peel — never one along the edge.
        strict = box.cls_name in ("Capacitor", "Battery")

        def runs(line: np.ndarray) -> list[np.ndarray]:
            idx = np.flatnonzero(line)
            return np.split(idx, np.flatnonzero(np.diff(idx) > 2) + 1) if idx.size else []

        def wire_only(band: np.ndarray, outside: np.ndarray, axis: int,
                      leads: list[float] | None) -> bool:
            """`band` is the strip just inside the edge, collapsed to a line so
            a wobbly wire counts as one run. Each run must continue ink from
            outside the edge (ink that starts inside the box is the symbol)
            and be a wire: reaching the box side (running along the edge),
            joined to outside ink at both ends (bending through the strip), or
            short (crossing the edge). On an edge the leads pass through,
            `leads` tracks each lead's position and a short run must follow
            one closely from step to step: a lead runs (nearly) straight in,
            while a zigzag stroke — just as thin — slants away sideways by
            over a pixel per step. Updates `leads` in place."""
            line = band.any(axis=axis)
            moved: list[tuple[int, float]] = []
            out = np.convolve(outside.any(axis=axis), np.ones(5), "same") > 0
            n = line.size
            for run in runs(line):
                lo, hi = run[0], run[-1]
                if not out[lo:hi + 1].any():
                    return False
                if not strict and (lo <= 2 or hi >= n - 3):
                    continue
                if not strict and out[lo:lo + k].any() and out[hi - k + 1:hi + 1].any() and hi - lo + 1 > short:
                    continue
                if hi - lo + 1 > short:
                    return False
                if leads is not None:
                    c = (lo + hi) / 2
                    j = int(np.argmin([abs(c - p) for p in leads])) if leads else -1
                    if j < 0 or abs(c - leads[j]) > 1.0:
                        return False
                    moved.append((j, c))
            if leads is not None:
                for j, c in moved:
                    leads[j] = c
            return True

        H, W = y2 - y1, x2 - x1
        # Edges crossed by the leads: top/bottom for a tall box, left/right
        # for a wide one, all four when it's about square.
        lead_tb = H >= W / 1.15
        lead_lr = W >= H / 1.15
        top, bot, left, right = 0, H, 0, W            # box edges, crop coords
        max_dy, max_dx = int(0.3 * H), int(0.3 * W)
        P = lambda r0, r1, c0, c1: pad[r0 + k:r1 + k, c0 + k:c1 + k]

        def entry(band: np.ndarray, axis: int, lead_edge: bool):
            return [float(r.mean()) for r in runs(band.any(axis=axis))] if lead_edge else None

        e = entry(P(0, k, 0, W), 0, lead_tb)
        while top < max_dy and wire_only(P(top, top + k, left, right), P(top - k, top, left, right), 0, e):
            top += 1
        e = entry(P(H - k, H, 0, W), 0, lead_tb)
        while H - bot < max_dy and wire_only(P(bot - k, bot, left, right), P(bot, bot + k, left, right), 0, e):
            bot -= 1
        e = entry(P(top, bot, 0, k), 1, lead_lr)
        while left < max_dx and wire_only(P(top, bot, left, left + k), P(top, bot, left - k, left), 1, e):
            left += 1
        e = entry(P(top, bot, W - k, W), 1, lead_lr)
        while W - right < max_dx and wire_only(P(top, bot, right - k, right), P(top, bot, right, right + k), 1, e):
            right -= 1
        return BoundingBox(x1=x1 + left, y1=y1 + top, x2=x1 + right, y2=y1 + bot,
                           cls_name=box.cls_name, conf=box.conf)

    # ── wire blobs ────────────────────────────────────────────────
    def _wire_labels(self, boxes: list[BoundingBox]) -> np.ndarray:
        wires = self.ink.copy()
        for b in boxes:
            cv2.fillConvexPoly(wires, box_poly(b), 0)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (self.gap, self.gap))
        wires = cv2.morphologyEx(wires, cv2.MORPH_CLOSE, kernel)
        # Closing may bleed back into boxes; keep them empty so contacts are
        # only ever measured in the ring outside.
        for b in boxes:
            cv2.fillConvexPoly(wires, box_poly(b), 0)
        _, labels = cv2.connectedComponents(wires, connectivity=8)
        return self._bridge_gaps(labels, boxes)

    def _bridge_gaps(self, labels: np.ndarray, boxes: list[BoundingBox]) -> np.ndarray:
        """Hand-drawn wires often stop just short of each other at corners
        and T-junctions. Join a blob to another when one of its free stroke
        ends (skeleton endpoint) lies within `bridge` px of the other blob.
        Ends that sit at a component box are terminals, not gaps, and are
        skipped so a part is never shorted across its own leads."""
        n = int(labels.max())
        if n < 2:
            return labels
        skel = skeletonize(labels > 0).astype(np.uint8)
        neighbours = cv2.filter2D(skel, -1, np.ones((3, 3), np.float32)) - skel
        ys, xs = np.nonzero((skel == 1) & (neighbours == 1))

        h, w = labels.shape
        near_box = np.zeros((h, w), np.uint8)
        for b in boxes:
            cv2.fillConvexPoly(near_box, box_poly(b), 1)
        r = self.ring * 2
        near_box = cv2.dilate(near_box, np.ones((2 * r + 1, 2 * r + 1), np.uint8)).astype(bool)

        parent = list(range(n + 1))

        def find(a: int) -> int:
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        R = self.bridge
        for y, x in zip(ys, xs):
            if near_box[y, x]:
                continue
            own = labels[y, x]
            y1, y2, x1, x2 = max(y - R, 0), min(y + R + 1, h), max(x - R, 0), min(x + R + 1, w)
            win = labels[y1:y2, x1:x2]
            other = (win > 0) & (win != own)
            if not other.any():
                continue
            oy, ox = np.nonzero(other)
            d2 = (oy + y1 - y) ** 2 + (ox + x1 - x) ** 2
            k = int(d2.argmin())
            if d2[k] <= R * R:
                parent[find(int(win[oy[k], ox[k]]))] = find(int(own))

        lut = np.array([find(i) for i in range(n + 1)], dtype=labels.dtype)
        return lut[labels]

    def _contacts(self, box: BoundingBox, labels: np.ndarray) -> list[_Contact]:
        h, w = labels.shape
        r = self.ring
        x1, y1 = max(box.x1 - r, 0), max(box.y1 - r, 0)
        x2, y2 = min(box.x2 + r, w), min(box.y2 + r, h)
        window = labels[y1:y2, x1:x2].copy()
        # Ring = the symbol's outline grown by `r`, minus the outline itself.
        inside = np.zeros(window.shape, np.uint8)
        cv2.fillConvexPoly(inside, box_poly(box) - np.array([x1, y1], np.int32), 1)
        ring = cv2.dilate(inside, np.ones((2 * r + 1, 2 * r + 1), np.uint8))
        window[(ring == 0) | (inside == 1)] = 0
        hit = (window > 0).astype(np.uint8)
        n, clusters, stats, cents = cv2.connectedComponentsWithStats(hit, connectivity=8)
        out: list[_Contact] = []
        for i in range(1, n):
            size = int(stats[i, cv2.CC_STAT_AREA])
            if size < self.min_contact:
                continue
            blob_ids = window[clusters == i]
            blob = int(np.bincount(blob_ids).argmax())
            out.append(_Contact(cents[i][0] + x1, cents[i][1] + y1, size, blob))
        return out

    # ── public ────────────────────────────────────────────────────
    def build(self, boxes: list[BoundingBox]):
        """Returns (components, conn_result, dropped_boxes)."""
        boxes = [self._tighten(b) for b in dedupe_boxes(boxes)]
        dropped: list[BoundingBox] = []
        for _ in range(3):
            labels = self._wire_labels(boxes)
            contacts = {id(b): self._contacts(b, labels) for b in boxes}
            # A wire joins at least two parts. Ink touching a single box is a
            # stub — typically label text next to the symbol — not a wire.
            touching: dict[int, set[int]] = {}
            for b in boxes:
                for c in contacts[id(b)]:
                    touching.setdefault(c.blob, set()).add(id(b))
            for b in boxes:
                contacts[id(b)] = [c for c in contacts[id(b)] if len(touching[c.blob]) > 1]
            orphans = [b for b in boxes if not contacts[id(b)]]
            if not orphans:
                break
            dropped += orphans
            boxes = [b for b in boxes if contacts[id(b)]]

        # Stable, readable reference designators: reading order.
        boxes.sort(key=lambda b: ((b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2))
        counters: dict[str, int] = {}
        components: list[ComponentTerminal] = []
        pin_blob: dict[str, int | None] = {}

        for b in boxes:
            pins, blobs = self._make_pins(b, contacts[id(b)])
            if b.cls_name == "Capacitor" and self._looks_like_battery(b, pins):
                # The detector often calls a battery a capacitor.
                b.cls_name = "Battery"
                pins, blobs = self._make_pins(b, contacts[id(b)])
            prefix = REFDES_PREFIX.get(b.cls_name, "X")
            counters[prefix] = counters.get(prefix, 0) + 1
            ref = f"{prefix}{counters[prefix]}"
            if b.cls_name in SOURCE_CLASSES:
                pins, method = self._orient_source(b, pins)
                self.polarity_method[ref] = method
            elif b.cls_name == "Diode" and self._diode_reversed(b, pins):
                # names only; list order stays positional (paired with blobs)
                pins = [Pin("cathode" if p.name == "anode" else "anode", p.x, p.y) for p in pins]
            components.append(ComponentTerminal(ref, b.cls_name, b, pins))
            for p, blob in zip(pins, blobs):
                pin_blob[f"{ref}.{p.name}"] = blob

        return components, self._nets(components, pin_blob), dropped

    def _make_pins(self, box: BoundingBox, contacts: list[_Contact]):
        poly = box_poly(box).astype(np.float64)
        cx, cy = poly[:, 0].mean(), poly[:, 1].mean()

        def on_edge(x: float, y: float) -> tuple[int, int]:
            """Project a contact onto the nearest point of the outline."""
            best, best_d = (x, y), np.inf
            for (ax, ay), (bx, by) in zip(poly, np.roll(poly, -1, axis=0)):
                dx, dy = bx - ax, by - ay
                t = ((x - ax) * dx + (y - ay) * dy) / max(dx * dx + dy * dy, 1e-9)
                t = min(max(t, 0.0), 1.0)
                px, py = ax + t * dx, ay + t * dy
                d = (px - x) ** 2 + (py - y) ** 2
                if d < best_d:
                    best, best_d = (px, py), d
            return int(round(best[0])), int(round(best[1]))

        if box.cls_name == "Ground":
            c = max(contacts, key=lambda c: c.size)
            return [Pin("GND", *on_edge(c.x, c.y))], [c.blob]

        if len(contacts) >= 2:
            # the two terminals are the pair of contacts farthest apart
            best = max(
                ((a, b) for i, a in enumerate(contacts) for b in contacts[i + 1:]),
                key=lambda ab: (ab[0].x - ab[1].x) ** 2 + (ab[0].y - ab[1].y) ** 2,
            )
            (ax, ay), (bx, by) = on_edge(best[0].x, best[0].y), on_edge(best[1].x, best[1].y)
            blob_a, blob_b = best[0].blob, best[1].blob
        else:
            # one wired terminal; the other end floats opposite it
            c = contacts[0]
            ax, ay = on_edge(c.x, c.y)
            bx, by = on_edge(2 * cx - c.x, 2 * cy - c.y)
            blob_a, blob_b = c.blob, None

        # Order the pair: first = left (horizontal) or top (vertical).
        if abs(bx - ax) >= abs(by - ay):
            swap = bx < ax
        else:
            swap = by < ay
        if swap:
            (ax, ay, blob_a), (bx, by, blob_b) = (bx, by, blob_b), (ax, ay, blob_a)
        horizontal = abs(bx - ax) >= abs(by - ay)

        cls = box.cls_name
        if cls in SOURCE_CLASSES:
            # terminal_extractor convention: + on top (vertical) / right (horizontal)
            names = ("+", "-") if not horizontal else ("-", "+")
        elif cls == "Diode":
            names = ("anode", "cathode")
        else:
            names = ("A", "B")
        return [Pin(names[0], ax, ay), Pin(names[1], bx, by)], [blob_a, blob_b]

    # ── source polarity ───────────────────────────────────────────
    def _orient_source(self, box: BoundingBox, pins: list[Pin]) -> tuple[list[Pin], str]:
        """Decide which terminal of a source is + from the symbol's own ink.
        `pins` arrive named by the default convention (+ top / right); they're
        swapped when the drawing says otherwise. Returns (pins, method)."""
        pos, neg = (pins[0], pins[1]) if pins[0].name == "+" else (pins[1], pins[0])
        plus_at = self._plus_from_marks(box, pos, neg)
        method = "marks"
        if plus_at is None:
            plus_at = self._plus_from_plates(box, pos, neg)
            method = "plates"
        if plus_at is None:
            return pins, "default"
        if plus_at is neg:
            # Drawing contradicts the default: swap the names only. List order
            # must stay positional — build() pairs pins with wire blobs by index.
            pins = [Pin("-" if p.name == "+" else "+", p.x, p.y) for p in pins]
        return pins, method

    def _diode_reversed(self, box: BoundingBox, pins: list[Pin]) -> bool:
        """True when the drawing puts the cathode at the pin named "anode".
        The triangle is narrow at the cathode bar and wide at its base, so
        compare the ink's width across the lead axis in the inner part of the
        symbol (the bar and the base, both full width, sit at the ends)."""
        a, c = (pins[0], pins[1]) if pins[0].name == "anode" else (pins[1], pins[0])
        crop = self._crop(box).astype(bool)
        horizontal = abs(c.x - a.x) >= abs(c.y - a.y)
        prof_src = crop if horizontal else crop.T      # columns step along the axis
        n = prof_src.shape[1]
        if n < 10:
            return False
        span = np.zeros(n)
        for i in range(n):
            rows = np.flatnonzero(prof_src[:, i])
            if rows.size:
                span[i] = rows[-1] - rows[0] + 1
        near_low = float(span[int(0.2 * n):int(0.45 * n)].mean())   # low index side
        near_high = float(span[int(0.55 * n):int(0.8 * n)].mean())
        if max(near_low, near_high) < 1.3 * max(min(near_low, near_high), 1.0):
            return False                               # can't tell: keep default
        narrow_low = near_low < near_high
        a_along = (a.x - box.x1) if horizontal else (a.y - box.y1)
        anode_low = a_along < n / 2
        return narrow_low == anode_low                 # anode at the narrow (bar) end

    def _crop(self, box: BoundingBox) -> np.ndarray:
        return self.ink[max(box.y1, 0):box.y2, max(box.x1, 0):box.x2]

    @staticmethod
    def _along(box: BoundingBox, a: Pin, b: Pin, x: float, y: float) -> float:
        """Position of (x, y) along the a→b axis: 0 at a, 1 at b."""
        ax, ay, bx, by = a.x - box.x1, a.y - box.y1, b.x - box.x1, b.y - box.y1
        dx, dy = bx - ax, by - ay
        return ((x - ax) * dx + (y - ay) * dy) / max(dx * dx + dy * dy, 1)

    def _plus_from_marks(self, box: BoundingBox, pos: Pin, neg: Pin) -> Pin | None:
        """Look for a drawn "+" / "−" inside the symbol (circle-style sources).
        Marks are small blobs not touching the box edge (so not the circle
        ring or the leads); a squarish, sparse blob is "+", a flat bar is "−"."""
        crop = self._crop(box)
        h, w = crop.shape
        size = max(h, w)
        if size < 12:
            return None
        # join the two strokes of a "+" that don't quite touch
        k = max(3, size // 40) | 1
        joined = cv2.dilate(crop, np.ones((k, k), np.uint8))
        n, lab, stats, cents = cv2.connectedComponentsWithStats(joined, connectivity=8)
        plus_t, minus_t = [], []
        for i in range(1, n):
            x, y, bw, bh, _ = stats[i]
            if x <= 1 or y <= 1 or x + bw >= w - 1 or y + bh >= h - 1:
                continue                      # touches the edge: ring / lead
            longest, shortest = max(bw, bh), max(min(bw, bh), 1)
            if longest > 0.45 * size or longest < 0.06 * size:
                continue                      # too big (ring) or a speck
            ink = int(np.count_nonzero(crop[lab == i]))
            fill = ink / float(bw * bh)
            t = self._along(box, pos, neg, *cents[i])
            if abs(t - 0.5) < 0.1:
                continue                      # centred mark says nothing about ends
            if longest / shortest >= 2.5 and bw > bh:
                minus_t.append(t)
            elif longest / shortest < 1.8 and fill < 0.55:
                plus_t.append(t)
        # t < 0.5 → nearer `pos` (the default + end)
        votes = [t < 0.5 for t in plus_t] + [t >= 0.5 for t in minus_t]
        if not votes or (any(votes) and not all(votes)):
            return None                       # nothing found, or contradictory
        return pos if votes[0] else neg

    def _looks_like_battery(self, box: BoundingBox, pins: list[Pin]) -> bool:
        """Plates across the lead axis, measured as the longest unbroken
        stroke at each step along it (labels beside the symbol don't count).
        A battery's alternate long (+) and short (−): four or more plates
        alternating, or two differing by ≥ 1.6×. A capacitor's are equal."""
        crop = self._crop(box).astype(bool)
        a, b = pins[0], pins[1]
        src = crop if abs(b.x - a.x) >= abs(b.y - a.y) else crop.T   # columns step along the axis
        across = src.shape[0]
        if across < 8:
            return False
        longest = np.zeros(src.shape[1])
        for i in range(src.shape[1]):
            idx = np.flatnonzero(src[:, i])
            if idx.size:
                longest[i] = max(len(r) for r in np.split(idx, np.flatnonzero(np.diff(idx) > 1) + 1))
        plates, start = [], None
        for i, v in enumerate(np.append(longest >= 0.35 * across, False)):
            if v and start is None:
                start = i
            elif not v and start is not None:
                plates.append(float(longest[start:i].max()))
                start = None
        if len(plates) == 2:
            return max(plates) >= 1.6 * min(plates)
        if len(plates) >= 4:
            steps = [p / q for p, q in zip(plates, plates[1:])]
            return all(r >= 1.2 for r in steps[::2]) and all(r <= 1 / 1.2 for r in steps[1::2])                 or all(r <= 1 / 1.2 for r in steps[::2]) and all(r >= 1.2 for r in steps[1::2])
        return False

    def _plus_from_plates(self, box: BoundingBox, pos: Pin, neg: Pin) -> Pin | None:
        """Battery symbol: two parallel plates across the lead axis, the
        longer one is +. Measures how wide the ink is across the axis at each
        step along it; plates are separate peaks in that profile. A circle
        gives one broad peak and is left undecided."""
        crop = self._crop(box).astype(bool)
        horizontal = abs(neg.x - pos.x) >= abs(neg.y - pos.y)
        prof_src = crop if horizontal else crop.T      # columns step along the axis
        across = prof_src.shape[0]
        span = np.zeros(prof_src.shape[1])
        for i in range(prof_src.shape[1]):
            rows = np.flatnonzero(prof_src[:, i])
            if rows.size:
                span[i] = rows[-1] - rows[0] + 1
        if across < 8:
            return None
        tall = span >= 0.35 * across
        runs, start = [], None
        for i, v in enumerate(np.append(tall, False)):
            if v and start is None:
                start = i
            elif not v and start is not None:
                runs.append((start, i - 1, float(span[start:i].max())))
                start = None
        if len(runs) < 2:
            return None
        # plate nearest each terminal
        p_along = (pos.x - box.x1) if horizontal else (pos.y - box.y1)
        n_along = (neg.x - box.x1) if horizontal else (neg.y - box.y1)
        centre = lambda r: (r[0] + r[1]) / 2
        near_pos = min(runs, key=lambda r: abs(centre(r) - p_along))
        near_neg = min(runs, key=lambda r: abs(centre(r) - n_along))
        if near_pos is near_neg:
            return None
        lp, ln = near_pos[2], near_neg[2]
        if max(lp, ln) < 1.3 * min(lp, ln):
            return None                       # plates about equal: can't tell
        return pos if lp > ln else neg

    @staticmethod
    def _nets(components: list[ComponentTerminal], pin_blob: dict[str, int | None]) -> ConnectivityResult:
        groups: dict[object, list[PinRef]] = {}
        for comp in components:
            for p in comp.pins:
                uid = f"{comp.component_id}.{p.name}"
                key = pin_blob[uid] if pin_blob[uid] is not None else ("float", uid)
                groups.setdefault(key, []).append(PinRef(comp.component_id, p.name, p.x, p.y))

        def is_gnd(pins):
            return any(p.pin_name == "GND" for p in pins)

        def is_vcc(pins):
            return any(p.pin_name == "+" and p.component_id.startswith("V") for p in pins)

        nets: list[Net] = []
        pin_to_net: dict[str, str] = {}
        counter = 1
        vcc_used = False
        ordered = sorted(groups.values(), key=lambda ps: (not is_gnd(ps), not is_vcc(ps), min(p.x for p in ps)))
        for pins in ordered:
            if is_gnd(pins):
                net_id = "GND"
            elif is_vcc(pins) and not vcc_used:
                net_id, vcc_used = "VCC", True
            else:
                net_id, counter = f"N{counter:03d}", counter + 1
            net = Net(net_id=net_id)
            for p in pins:
                net.add_pin(p)
                pin_to_net[p.uid] = net_id
            nets.append(net)

        # GND with multiple ground symbols: merge into a single net.
        gnd = [n for n in nets if n.net_id == "GND"]
        if len(gnd) > 1:
            for extra in gnd[1:]:
                gnd[0].pin_refs |= extra.pin_refs
                nets.remove(extra)

        return ConnectivityResult(nets=nets, pin_to_net=pin_to_net, unmatched_pts=[])

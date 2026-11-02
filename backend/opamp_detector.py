"""
Op-amp detection from the drawing's shape.

The default YOLO weights have no op-amp class, and the one model that has
it rarely fires on real drawings. When an op-amp is missed its triangle
outline is read as wire, which shorts +, − and the output together and
collapses most of the circuit into one net. An op-amp is however an easy
shape to find directly: a closed triangle, roughly isosceles, with its flat
(input) side axis-aligned and the output tip opposite.

Two kinds of drawing are covered:
  * outline triangles (pen / canvas strokes): the hole inside the stroke is
    the triangle;
  * filled triangles (coloured symbol): opening the ink with a kernel wider
    than a wire removes the wires and leaves the solid triangle.

Diodes are triangles too, so a candidate a YOLO diode box overlaps is skipped.
"""

from __future__ import annotations

import cv2
import numpy as np

# How closely the contour must fill its minimum enclosing triangle.
TRI_FILL_MIN = 0.85
# A triangle fills half its minimum-area rectangle; a rectangle fills all of it.
RECT_FILL_MAX = 0.72
# The flat side's slope from horizontal/vertical, in degrees.
FLAT_SIDE_MAX_TILT = 20.0
# Where the tip projects onto the flat side, as a share of the side's length
# from its midpoint (0 = isosceles).
TIP_OFFSET_MAX = 0.25
# Height / flat-side length of a plausible op-amp symbol.
ASPECT_RANGE = (0.5, 1.8)
# Smallest triangle side, as a share of the image diagonal.
MIN_SIDE_FRAC = 0.04


def _triangle_of(contour: np.ndarray) -> np.ndarray | None:
    """The 3x2 enclosing triangle when `contour` is triangle-shaped, else None."""
    area = cv2.contourArea(contour)
    if area <= 0:
        return None
    tri_area, tri = cv2.minEnclosingTriangle(contour.astype(np.float32))
    if tri is None or tri_area <= 0 or area / tri_area < TRI_FILL_MIN:
        return None
    (_, _), (rw, rh), _ = cv2.minAreaRect(contour)
    if rw * rh <= 0 or area / (rw * rh) > RECT_FILL_MAX:
        return None
    return tri.reshape(3, 2).astype(np.float64)


def _opamp_shaped(tri: np.ndarray, min_side: float) -> bool:
    """One side (the inputs) is near horizontal or vertical, the opposite
    vertex (the output) sits roughly over its middle, and the proportions
    are those of an amplifier symbol."""
    for i in range(3):
        a, b, tip = tri[i], tri[(i + 1) % 3], tri[(i + 2) % 3]
        side = b - a
        length = float(np.hypot(*side))
        if length < min_side:
            continue
        angle = np.degrees(np.arctan2(abs(side[1]), abs(side[0])))
        tilt = min(angle, 90.0 - angle)
        if tilt > FLAT_SIDE_MAX_TILT:
            continue
        u = side / length
        rel = tip - (a + b) / 2
        offset = abs(float(rel @ u)) / length
        height = abs(float(rel[0] * u[1] - rel[1] * u[0]))
        if offset <= TIP_OFFSET_MAX and ASPECT_RANGE[0] <= height / length <= ASPECT_RANGE[1]:
            return True
    return False


def _offset(tri: np.ndarray, d: float) -> np.ndarray:
    """Move every side of the triangle outward by `d`: scale about the
    incentre by (r + d) / r, r the inradius."""
    a = np.linalg.norm(tri[1] - tri[2])
    b = np.linalg.norm(tri[2] - tri[0])
    c = np.linalg.norm(tri[0] - tri[1])
    per = a + b + c
    if per <= 0:
        return tri
    inc = (a * tri[0] + b * tri[1] + c * tri[2]) / per
    area = 0.5 * abs(np.cross(tri[1] - tri[0], tri[2] - tri[0]))
    r = 2 * area / per
    return inc + (tri - inc) * ((r + d) / max(r, 1e-6))


def _stroke_width(ink: np.ndarray) -> float:
    """Typical stroke width: twice the median distance-to-background along
    the skeleton (as DrawnTopology measures it). A filled symbol adds only a
    short skeleton, so it doesn't skew this."""
    from skimage.morphology import skeletonize
    skel = skeletonize(ink > 0)
    if not skel.any():
        return 3.0
    dist = cv2.distanceTransform(ink, cv2.DIST_L2, 3)
    return max(2.0, 2.0 * float(np.median(dist[skel])))


def find_opamp_triangles(ink: np.ndarray) -> list[tuple[np.ndarray, float]]:
    """Op-amp triangles in an ink mask (uint8 0/1): (3x2 outer vertices,
    score 0..1) per symbol."""
    h, w = ink.shape
    min_side = MIN_SIDE_FRAC * float(np.hypot(w, h))
    stroke = _stroke_width(ink)
    found: list[tuple[np.ndarray, float]] = []

    def add(tri: np.ndarray, score: float) -> None:
        c = tri.mean(0)
        for j, (t, s) in enumerate(found):
            if cv2.pointPolygonTest(t.astype(np.float32), (float(c[0]), float(c[1])), False) >= 0:
                if score > s:
                    found[j] = (tri, score)
                return
        found.append((tri, score))

    # Outline triangles: holes (inner contours) of the ink.
    closed = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    contours, hier = cv2.findContours(closed, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hier is not None:
        for cnt, hrow in zip(contours, hier[0]):
            if hrow[3] < 0:          # outer contour; holes have a parent
                continue
            tri = _triangle_of(cnt)
            if tri is None or not _opamp_shaped(tri, min_side):
                continue
            # grow from the inner edge of the stroke to its outer edge
            add(_offset(tri, stroke), cv2.contourArea(cnt) / cv2.minEnclosingTriangle(
                cnt.astype(np.float32))[0])

    # Filled triangles: remove wire-thin strokes, keep solid regions.
    k = int(round(stroke * 3)) | 1
    solid = cv2.morphologyEx(ink, cv2.MORPH_OPEN,
                             cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    contours, _ = cv2.findContours(solid, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for cnt in contours:
        tri = _triangle_of(cnt)
        if tri is None or not _opamp_shaped(tri, min_side):
            continue
        add(tri, cv2.contourArea(cnt) / cv2.minEnclosingTriangle(cnt.astype(np.float32))[0])
    return found


def _inside(tri: np.ndarray, x: float, y: float) -> bool:
    return cv2.pointPolygonTest(tri.astype(np.float32), (float(x), float(y)), False) >= 0


def _overlap(box, x1, y1, x2, y2) -> float:
    """Share of `box`'s area inside the rectangle (x1, y1, x2, y2)."""
    iw = max(0, min(box.x2, x2) - max(box.x1, x1))
    ih = max(0, min(box.y2, y2) - max(box.y1, y1))
    area = max((box.x2 - box.x1) * (box.y2 - box.y1), 1)
    return iw * ih / area


def add_opamps(ink: np.ndarray, boxes: list) -> list:
    """Add an "Op-Amp" box for every op-amp triangle in the ink, and drop
    detections that are really pieces of it (YOLO reads the "741" label or
    the + / − marks inside as capacitors, grounds...). A triangle a diode
    box covers is a diode, not an op-amp."""
    from wire_detector import BoundingBox

    h, w = ink.shape
    for tri, score in find_opamp_triangles(ink):
        x1, y1 = np.floor(tri.min(0)).astype(int)
        x2, y2 = np.ceil(tri.max(0)).astype(int)
        x1, y1, x2, y2 = max(int(x1), 0), max(int(y1), 0), min(int(x2), w - 1), min(int(y2), h - 1)
        if any(b.cls_name == "Diode" and _overlap(b, x1, y1, x2, y2) > 0.3 for b in boxes):
            continue
        kept = []
        for b in boxes:
            cx, cy = (b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2
            if b.cls_name == "Op-Amp" or _inside(tri, cx, cy) or _overlap(b, x1, y1, x2, y2) > 0.5:
                continue
            kept.append(b)
        kept.append(BoundingBox(x1=x1, y1=y1, x2=x2, y2=y2, cls_name="Op-Amp",
                                conf=round(min(0.99, float(score)), 3)))
        boxes = kept
    return boxes

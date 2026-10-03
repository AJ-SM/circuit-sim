"""
Stage 1 — Wire Detector
========================
Detects wires in a hand-drawn circuit image using:
  1. Preprocessing (grayscale, blur, adaptive threshold)
  2. Component region masking (erases detected component boxes)
  3. Morphological skeletonization (thins lines to 1px)
  4. Fast junction/endpoint detection via NumPy convolution
  5. Hough line segment extraction

Key fix: uses NumPy convolution for node detection (NOT pixel loops).
Also auto-downscales large phone photos for speed.
"""

import cv2
import numpy as np
from dataclasses import dataclass, field
from typing import List, Tuple


Point   = Tuple[int, int]
Segment = Tuple[Point, Point]


@dataclass
class BoundingBox:
    x1: int
    y1: int
    x2: int
    y2: int
    cls_name: str
    conf: float


@dataclass
class WireDetectionResult:
    segments    : List[Segment] = field(default_factory=list)
    junctions   : List[Point]   = field(default_factory=list)
    endpoints   : List[Point]   = field(default_factory=list)
    skeleton_img: np.ndarray    = field(default_factory=lambda: np.zeros((1, 1), np.uint8))
    wire_mask   : np.ndarray    = field(default_factory=lambda: np.zeros((1, 1), np.uint8))


class WireDetector:
    def __init__(
        self,
        component_padding: int = 8,
        min_wire_length  : int = 15,
        junction_radius  : int = 8,
        max_image_size   : int = 1024,
    ):
        self.component_padding = component_padding
        self.min_wire_length   = min_wire_length
        self.junction_radius   = junction_radius
        self.max_image_size    = max_image_size

    def detect(self, image: np.ndarray, component_boxes: List[BoundingBox]) -> WireDetectionResult:
        h, w = image.shape[:2]
        scale = 1.0

        # Downscale large images for speed
        if max(h, w) > self.max_image_size:
            scale   = self.max_image_size / max(h, w)
            new_w   = int(w * scale)
            new_h   = int(h * scale)
            image_p = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_AREA)
            boxes_p = [
                BoundingBox(
                    int(b.x1 * scale), int(b.y1 * scale),
                    int(b.x2 * scale), int(b.y2 * scale),
                    b.cls_name, b.conf
                )
                for b in component_boxes
            ]
        else:
            image_p = image
            boxes_p = component_boxes

        wire_mask           = self._preprocess(image_p, boxes_p)
        skeleton            = self._skeletonize(wire_mask)
        junctions, endpoints = self._find_nodes_fast(skeleton)
        segments            = self._hough_lines(skeleton)
        segments            = [s for s in segments if self._seg_len(s) >= self.min_wire_length]

        # Scale coords back to original image size
        if scale != 1.0:
            inv       = 1.0 / scale
            segments  = [
                ((int(x1 * inv), int(y1 * inv)), (int(x2 * inv), int(y2 * inv)))
                for (x1, y1), (x2, y2) in segments
            ]
            junctions = [(int(x * inv), int(y * inv)) for x, y in junctions]
            endpoints = [(int(x * inv), int(y * inv)) for x, y in endpoints]
            skeleton  = cv2.resize(skeleton,  (w, h), interpolation=cv2.INTER_NEAREST)
            wire_mask = cv2.resize(wire_mask, (w, h), interpolation=cv2.INTER_NEAREST)

        return WireDetectionResult(
            segments=segments,
            junctions=junctions,
            endpoints=endpoints,
            skeleton_img=skeleton,
            wire_mask=wire_mask,
        )

    # ── Preprocessing ─────────────────────────────────────────────

    def _preprocess(self, image: np.ndarray, boxes: List[BoundingBox]) -> np.ndarray:
        gray   = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        gray   = cv2.GaussianBlur(gray, (3, 3), 0)
        binary = cv2.adaptiveThreshold(
            gray, 255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV,
            blockSize=15, C=8
        )
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
        binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)

        # Erase component bounding box regions
        p = self.component_padding
        for b in boxes:
            y1 = max(0, b.y1 - p)
            y2 = min(binary.shape[0], b.y2 + p)
            x1 = max(0, b.x1 - p)
            x2 = min(binary.shape[1], b.x2 + p)
            binary[y1:y2, x1:x2] = 0

        return binary

    # ── Skeletonization ───────────────────────────────────────────

    def _skeletonize(self, binary: np.ndarray) -> np.ndarray:
        try:
            from skimage.morphology import skeletonize as ski_skel
            return (ski_skel(binary.astype(bool)) * 255).astype(np.uint8)
        except ImportError:
            # Fallback: OpenCV morphological thinning
            img  = binary.copy()
            skel = np.zeros_like(img)
            k    = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
            for _ in range(100):
                er   = cv2.erode(img, k)
                t    = cv2.subtract(img, cv2.dilate(er, k))
                skel = cv2.bitwise_or(skel, t)
                img  = er
                if cv2.countNonZero(img) == 0:
                    break
            return skel

    # ── Fast node detection via NumPy convolution ─────────────────

    def _find_nodes_fast(self, skeleton: np.ndarray) -> Tuple[List[Point], List[Point]]:
        """
        One-pass neighbor counting using cv2.filter2D.
        No Python loops over pixels — runs in milliseconds.
        """
        skel = (skeleton > 0).astype(np.uint8)

        # 3x3 kernel that counts 8-connected neighbors (center excluded)
        kernel = np.ones((3, 3), dtype=np.float32)
        kernel[1, 1] = 0

        nc = cv2.filter2D(skel.astype(np.float32), -1, kernel)
        nc = (nc * skel).astype(np.uint8)  # zero out non-skeleton pixels

        # Endpoints  = skeleton pixel with exactly 1 neighbor
        ep_mask = (skel == 1) & (nc == 1)
        # Junctions = skeleton pixel with 3 or more neighbors
        jn_mask = (skel == 1) & (nc >= 3)

        ep_coords = np.column_stack(np.where(ep_mask)) if ep_mask.any() else np.empty((0, 2), int)
        jn_coords = np.column_stack(np.where(jn_mask)) if jn_mask.any() else np.empty((0, 2), int)

        # np.where returns (row, col) → convert to (x=col, y=row)
        endpoints  = self._merge_nearby([(int(c), int(r)) for r, c in ep_coords])
        junctions  = self._merge_nearby([(int(c), int(r)) for r, c in jn_coords])

        return junctions, endpoints

    def _merge_nearby(self, points: List[Point]) -> List[Point]:
        """Cluster nearby points and replace each cluster with its centroid."""
        if not points:
            return []
        pts    = np.array(points, dtype=float)
        used   = [False] * len(pts)
        merged = []
        r      = self.junction_radius

        for i in range(len(pts)):
            if used[i]:
                continue
            cluster = [pts[i]]
            used[i] = True
            for j in range(i + 1, len(pts)):
                if not used[j] and np.linalg.norm(pts[i] - pts[j]) < r:
                    cluster.append(pts[j])
                    used[j] = True
            c = np.mean(cluster, axis=0)
            merged.append((int(c[0]), int(c[1])))

        return merged

    # ── Hough line extraction ─────────────────────────────────────

    def _hough_lines(self, skeleton: np.ndarray) -> List[Segment]:
        lines = cv2.HoughLinesP(
            skeleton,
            rho           = 1,
            theta         = np.pi / 180,
            threshold     = 15,
            minLineLength = self.min_wire_length,
            maxLineGap    = 12,
        )
        if lines is None:
            return []
        return [
            ((int(x1), int(y1)), (int(x2), int(y2)))
            for x1, y1, x2, y2 in lines[:, 0]
        ]

    @staticmethod
    def _seg_len(seg: Segment) -> float:
        (x1, y1), (x2, y2) = seg
        return ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5


# ── Visualization helper ──────────────────────────────────────────

def visualize_wires(
    image  : np.ndarray,
    result : WireDetectionResult,
    boxes  : List[BoundingBox] = None,
) -> np.ndarray:
    vis = image.copy()
    for (x1, y1), (x2, y2) in result.segments:
        cv2.line(vis, (x1, y1), (x2, y2), (0, 200, 255), 2)
    for x, y in result.junctions:
        cv2.circle(vis, (x, y), 5, (0, 255, 0), -1)
    for x, y in result.endpoints:
        cv2.circle(vis, (x, y), 4, (255, 100, 0), -1)
    if boxes:
        for b in boxes:
            cv2.rectangle(vis, (b.x1, b.y1), (b.x2, b.y2), (0, 0, 255), 2)
            cv2.putText(vis, b.cls_name, (b.x1, b.y1 - 6),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1)
    return vis


# ── Standalone test ───────────────────────────────────────────────
if __name__ == "__main__":
    import sys
    img_path = sys.argv[1] if len(sys.argv) > 1 else "mycircuit1.jpeg"
    img = cv2.imread(img_path)
    if img is None:
        print(f"Could not read: {img_path}")
        exit()
    det    = WireDetector()
    result = det.detect(img, [])
    print(f"Segments : {len(result.segments)}")
    print(f"Junctions: {len(result.junctions)}")
    print(f"Endpoints: {len(result.endpoints)}")
    vis = visualize_wires(img, result)
    cv2.imshow("Wires", vis)
    cv2.waitKey(0)
    cv2.destroyAllWindows()

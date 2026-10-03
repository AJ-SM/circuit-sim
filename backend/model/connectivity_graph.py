"""
Stage 3 — Connectivity Graph
==============================
Builds a graph connecting component terminals via detected wires.

Algorithm (2-phase):
  Phase 1 — Wire Graph:
    1. Collect all wire segment endpoints, junctions, and endpoint markers
    2. Union wire points that are within wire_gap pixels of each other
    3. Also union the two endpoints of every wire segment
    This gives a set of "wire clusters" — groups of wire points that are
    physically connected through wire chains.

  Phase 2 — Pin Snapping:
    4. For each component pin, find the nearest wire point within snap_distance
    5. Map the pin to that wire point's cluster root
    6. All pins mapped to the same cluster → same net

  Additionally:
    - Pins that are within snap_distance of each other are directly merged
      (handles direct pin-to-pin connections without a wire segment)
    - Net naming: GND if a GND pin exists, VCC if a "+" pin of a voltage
      source exists, else "N001", "N002", ...

Returns:
  ConnectivityResult with:
    - nets      : list of Net objects (set of connected pins), properly
                  populated with ALL pins in each net
    - pin_to_net: dict mapping pin uid → net id
    - unmatched : component pins that didn't snap to any wire cluster
"""

import math
from dataclasses import dataclass, field
from typing import List, Dict, Set, Tuple, Optional

from wire_detector import WireDetectionResult, Segment, Point
from terminal_extractor import ComponentTerminal, Pin


# ── Data Types ────────────────────────────────────────────────────

@dataclass
class PinRef:
    """Unique reference to a component pin."""
    component_id: str    # e.g. "R1"
    pin_name    : str    # e.g. "A", "B", "+", "GND"
    x           : int
    y           : int

    @property
    def uid(self) -> str:
        return f"{self.component_id}.{self.pin_name}"

    def __hash__(self):
        return hash(self.uid)

    def __eq__(self, other):
        return self.uid == other.uid


@dataclass
class Net:
    """A net = a set of pins connected together by wires."""
    net_id    : str           # e.g. "GND", "VCC", "N001"
    pin_refs  : Set[PinRef] = field(default_factory=set)

    def add_pin(self, pin: PinRef):
        self.pin_refs.add(pin)

    @property
    def pin_uids(self) -> List[str]:
        return sorted([p.uid for p in self.pin_refs])


@dataclass
class ConnectivityResult:
    nets         : List[Net]
    pin_to_net   : Dict[str, str]   # pin uid → net id
    unmatched_pts: List[PinRef]      # pins that didn't snap to any wire


# ── Union-Find ────────────────────────────────────────────────────

class UnionFind:
    def __init__(self):
        self.parent: Dict[str, str] = {}

    def find(self, x: str) -> str:
        if x not in self.parent:
            self.parent[x] = x
        if self.parent[x] != x:
            self.parent[x] = self.find(self.parent[x])
        return self.parent[x]

    def union(self, x: str, y: str):
        rx, ry = self.find(x), self.find(y)
        if rx != ry:
            self.parent[ry] = rx

    def roots(self) -> Set[str]:
        return {self.find(k) for k in self.parent}


# ── Connectivity Graph Builder ────────────────────────────────────

class ConnectivityGraphBuilder:
    def __init__(
        self,
        snap_distance: int = 40,    # max pixels to snap a pin to a wire point
        wire_gap     : int = 25,    # max gap between wire points to chain them
    ):
        self.snap_distance = snap_distance
        self.wire_gap      = wire_gap

    def build(
        self,
        components  : List[ComponentTerminal],
        wire_result : WireDetectionResult,
    ) -> ConnectivityResult:
        """
        Build connectivity from components and wire detection result.

        Args:
            components  : list of ComponentTerminal from terminal_extractor
            wire_result : WireDetectionResult from wire_detector

        Returns:
            ConnectivityResult with properly grouped multi-pin nets
        """

        # ── Flatten all component pins ────────────────────────────
        all_pins: List[PinRef] = []
        for comp in components:
            for pin in comp.pins:
                all_pins.append(PinRef(
                    component_id = comp.component_id,
                    pin_name     = pin.name,
                    x            = pin.x,
                    y            = pin.y,
                ))

        # ── Collect all wire points ───────────────────────────────
        # Key them as strings "x,y" for use in UnionFind
        wire_pts: List[Tuple[int, int]] = []

        for seg in wire_result.segments:
            wire_pts.append(seg[0])
            wire_pts.append(seg[1])
        for junc in wire_result.junctions:
            wire_pts.append(junc)
        for ep in wire_result.endpoints:
            wire_pts.append(ep)

        # Deduplicate wire points (keep unique)
        seen = set()
        unique_wire_pts: List[Tuple[int, int]] = []
        for pt in wire_pts:
            key = (pt[0], pt[1])
            if key not in seen:
                seen.add(key)
                unique_wire_pts.append(key)

        def pt_key(pt: Tuple[int, int]) -> str:
            return f"{pt[0]},{pt[1]}"

        # ── Phase 1: Build wire-point Union-Find ──────────────────
        # Every wire point is its own node. We union points that are:
        #   (a) the two endpoints of the same segment, OR
        #   (b) within wire_gap pixels of each other (junction chaining)

        wire_uf = UnionFind()
        for pt in unique_wire_pts:
            wire_uf.find(pt_key(pt))   # register

        # (a) Union segment endpoints
        for seg in wire_result.segments:
            p1, p2 = seg
            wire_uf.union(pt_key(p1), pt_key(p2))

        # (b) Union wire points that are very close (handles gaps/junctions)
        for i, pa in enumerate(unique_wire_pts):
            for pb in unique_wire_pts[i+1:]:
                if self._dist(pa, pb) <= self.wire_gap:
                    wire_uf.union(pt_key(pa), pt_key(pb))

        # ── Phase 2: Snap component pins to wire clusters ─────────
        # For each pin, find the nearest wire point within snap_distance.
        # Map the pin to that wire point's cluster root.

        pin_uf = UnionFind()
        for pin in all_pins:
            pin_uf.find(pin.uid)   # register each pin

        # Also extend wire cluster roots into pin space:
        # Give each wire cluster root a synthetic "wire_<root>" node in pin_uf
        wire_cluster_nodes: Dict[str, str] = {}   # cluster_root → synthetic node
        for root in wire_uf.roots():
            node = f"wire__{root}"
            pin_uf.find(node)
            wire_cluster_nodes[root] = node

        unmatched_pins: List[PinRef] = []

        for pin in all_pins:
            best_pt   = None
            best_dist = float("inf")

            for wpt in unique_wire_pts:
                d = self._dist((pin.x, pin.y), wpt)
                if d < best_dist:
                    best_dist = d
                    best_pt   = wpt

            if best_pt is not None and best_dist <= self.snap_distance:
                cluster_root = wire_uf.find(pt_key(best_pt))
                wire_node    = wire_cluster_nodes[cluster_root]
                pin_uf.union(pin.uid, wire_node)
            else:
                # No wire nearby — leave isolated (may merge with adjacent pin below)
                unmatched_pins.append(pin)

        # ── Phase 3: Direct pin-to-pin proximity merge ────────────
        # Handles cases where two component pins touch directly (no wire)
        for i, pa in enumerate(all_pins):
            for pb in all_pins[i+1:]:
                if self._dist((pa.x, pa.y), (pb.x, pb.y)) <= self.snap_distance:
                    pin_uf.union(pa.uid, pb.uid)

        # ── Phase 4: Group pins by cluster root ───────────────────
        root_to_pins: Dict[str, List[PinRef]] = {}
        for pin in all_pins:
            root = pin_uf.find(pin.uid)
            # Only group actual component pins (skip synthetic wire nodes)
            if not root.startswith("wire__"):
                root_to_pins.setdefault(root, []).append(pin)
            else:
                # Root is a wire node — find via pin's own root
                root_to_pins.setdefault(root, []).append(pin)

        # Re-key: group by the canonical root (might be a wire__ node)
        canonical: Dict[str, List[PinRef]] = {}
        for pin in all_pins:
            root = pin_uf.find(pin.uid)
            canonical.setdefault(root, []).append(pin)

        # ── Phase 5: Name and build Net objects ───────────────────
        nets        : List[Net] = []
        pin_to_net  : Dict[str, str] = {}
        net_counter = 1

        for root, pins in canonical.items():
            net_id = self._name_net(pins, net_counter)
            if net_id.startswith("N"):
                net_counter += 1

            net = Net(net_id=net_id)
            for pin in pins:
                net.add_pin(pin)
                pin_to_net[pin.uid] = net_id

            nets.append(net)

        # Sort: GND first, VCC/VDD second, then N001 ...
        nets.sort(key=lambda n: (
            0 if n.net_id == "GND" else
            1 if n.net_id in ("VCC", "VDD") else
            2,
            n.net_id
        ))

        # Filter unmatched to only those still truly isolated
        # (a pin may have been merged via direct proximity in Phase 3)
        truly_unmatched = [
            p for p in unmatched_pins
            if len(canonical.get(pin_uf.find(p.uid), [])) == 1
        ]

        return ConnectivityResult(
            nets          = nets,
            pin_to_net    = pin_to_net,
            unmatched_pts = truly_unmatched,
        )

    # ── Helpers ───────────────────────────────────────────────────

    @staticmethod
    def _dist(a: Tuple[int, int], b: Tuple[int, int]) -> float:
        return math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2)

    @staticmethod
    def _name_net(pins: List[PinRef], counter: int) -> str:
        """
        Priority net naming:
          - Contains a "GND" pin → "GND"
          - Contains a "+" pin of a Voltage source (component_id starts with V) → "VCC"
          - Otherwise → "N{counter:03d}"
        """
        for pin in pins:
            if pin.pin_name.upper() == "GND":
                return "GND"
        for pin in pins:
            if pin.pin_name == "+" and pin.component_id.startswith("V"):
                return "VCC"
        return f"N{counter:03d}"


# ── Visualization ─────────────────────────────────────────────────

NET_COLORS = [
    (255,  82,  82),   # red
    (  0, 200, 255),   # cyan
    (180,  60, 255),   # purple
    ( 60, 220,  60),   # green
    (255, 220,   0),   # yellow
    (255, 100, 180),   # pink
    (  0, 150, 255),   # blue
    (255, 165,   0),   # orange
]

def visualize_connectivity(
    image : object,  # np.ndarray
    components: List[ComponentTerminal],
    wire_result: WireDetectionResult,
    conn_result: ConnectivityResult,
) -> object:
    import cv2
    import numpy as np

    vis = image.copy()

    # Build net → color map
    net_color_map = {}
    for i, net in enumerate(conn_result.nets):
        if net.net_id == "GND":
            net_color_map[net.net_id] = (100, 100, 255)
        elif net.net_id in ("VCC", "VDD"):
            net_color_map[net.net_id] = (0, 255, 0)
        else:
            net_color_map[net.net_id] = NET_COLORS[i % len(NET_COLORS)]

    # Draw wire segments colored by net
    for seg in wire_result.segments:
        cv2.line(vis, seg[0], seg[1], (200, 200, 200), 2)

    # Draw component terminals colored by net
    for comp in components:
        for pin in comp.pins:
            pin_uid = f"{comp.component_id}.{pin.name}"
            net_id  = conn_result.pin_to_net.get(pin_uid, "?")
            color   = net_color_map.get(net_id, (128, 128, 128))
            cv2.circle(vis, (pin.x, pin.y), 7, color, -1)
            cv2.circle(vis, (pin.x, pin.y), 7, (255,255,255), 1)
            cv2.putText(vis, net_id,
                        (pin.x + 8, pin.y + 4),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.35,
                        color, 1, cv2.LINE_AA)

    # Draw junction points
    for junc in wire_result.junctions:
        cv2.circle(vis, junc, 5, (0, 255, 0), -1)

    return vis


# ── Standalone test ───────────────────────────────────────────────
if __name__ == "__main__":
    from wire_detector import WireDetectionResult
    from terminal_extractor import ComponentTerminal, Pin, BoundingBox

    # Simulate a simple R-C-V circuit where wires chain through midpoints
    #
    #   R1.A ---wire--- midpoint ---wire--- V1.+
    #   R1.B ---wire--- midpoint ---wire--- C1.A
    #   C1.B ---wire--- midpoint ---wire--- V1.-  (= GND)
    #   V1.- ---wire--- GND1.GND
    #
    # Note: no wire has pins at BOTH endpoints (realistic scenario)

    boxes = [
        BoundingBox(50,  100, 150, 140, "Resistor",  0.95),
        BoundingBox(200, 100, 300, 140, "Capacitor", 0.90),
        BoundingBox(350,  80, 430, 160, "Voltage",   0.88),
        BoundingBox(200, 220, 250, 280, "Ground",    0.97),
    ]

    from terminal_extractor import TerminalExtractor
    extractor  = TerminalExtractor(pin_inset=0.05)
    components = extractor.extract(boxes)

    print("Component pins:")
    for comp in components:
        for pin in comp.pins:
            print(f"  {comp.component_id}.{pin.name} @ ({pin.x}, {pin.y})")

    # Wires: realistic chains (midpoints only, pins are NOT exactly at endpoints)
    #   wire_gap=25 will chain midpoints together
    #   snap_distance=40 will snap pins to nearest wire point
    wire_result = WireDetectionResult(
        segments=[
            ((155, 120), (195, 120)),   # R1.B side ← midpoint chain → C1.A side
            ((305, 120), (345, 120)),   # C1.B side → V1.- side
            ((435, 120), (435, 230)),   # V1.+ down
            ((435, 230), (230, 230)),   # bottom rail
            ((230, 230), (230, 280)),   # → GND
            ((55,  120), (55,  230)),   # R1.A down
            ((55,  230), (155, 230)),   # bottom rail segment
        ],
        junctions=[],
        endpoints=[],
    )

    builder = ConnectivityGraphBuilder(snap_distance=40, wire_gap=25)
    result  = builder.build(components, wire_result)

    print("\nNets:")
    for net in result.nets:
        print(f"  {net.net_id:8s} -> {', '.join(net.pin_uids)}")

    print(f"\nUnmatched pins: {[p.uid for p in result.unmatched_pts]}")

    # Expected output:
    #   N001     → R1.B, C1.A

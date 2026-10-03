"""
Stage 2 — Terminal Extractor
==============================
Computes the pin/terminal positions for each detected component.

Each component type has a defined number of terminals at known
positions relative to its bounding box.

Terminal convention:
  - Most 2-terminal components: LEFT-CENTER (pin A) and RIGHT-CENTER (pin B)
  - Ground: TOP-CENTER (single terminal)
  - Diode:  LEFT-CENTER (anode) and RIGHT-CENTER (cathode)
  - Battery/Voltage: LEFT-CENTER (negative) and RIGHT-CENTER (positive)

Returns:
  List of ComponentTerminal objects, each with:
    - component_id  : unique ID (e.g. "R1", "C2")
    - cls_name      : class name (e.g. "Resistor")
    - bounding_box  : BoundingBox
    - pins          : list of Pin(name, x, y)
"""

from dataclasses import dataclass, field
from typing import List, Tuple
from wire_detector import BoundingBox


# ── Data Types ────────────────────────────────────────────────────

@dataclass
class Pin:
    name: str   # e.g. "A", "B", "anode", "cathode", "+", "-", "GND"
    x   : int
    y   : int

    def as_tuple(self) -> Tuple[int, int]:
        return (self.x, self.y)


@dataclass
class ComponentTerminal:
    component_id: str           # e.g. "R1", "C2", "V1"
    cls_name    : str           # e.g. "Resistor"
    box         : BoundingBox
    pins        : List[Pin] = field(default_factory=list)

    def center(self) -> Tuple[int, int]:
        return (
            (self.box.x1 + self.box.x2) // 2,
            (self.box.y1 + self.box.y2) // 2,
        )


# ── Component Reference Designators ──────────────────────────────

# Maps class name → reference designator prefix
REFDES_PREFIX = {
    "Resistor"  : "R",
    "Capacitor" : "C",
    "Inductor"  : "L",
    "Diode"     : "D",
    "Battery"   : "V",
    "Voltage"   : "V",
    "AC Source" : "V",
    "Ground"    : "GND",
}


# ── Terminal Extractor ────────────────────────────────────────────

class TerminalExtractor:
    """
    Extracts pin positions from YOLO bounding boxes.

    For horizontal components (default):
      Pin A = left-center of bounding box
      Pin B = right-center of bounding box

    Orientation detection:
      If bounding box width < height → component is VERTICAL
      In vertical mode, pins are top-center and bottom-center
    """

    def __init__(self, pin_inset: float = 0.05):
        """
        Args:
            pin_inset: fraction of box size to inset pins from the edge
                       (0.0 = exactly at edge, 0.1 = 10% inset)
        """
        self.pin_inset = pin_inset
        self._counters = {}   # tracks how many of each class seen

    def extract(self, boxes: List[BoundingBox]) -> List[ComponentTerminal]:
        """
        Compute terminals for all detected components.

        Args:
            boxes: list of BoundingBox from YOLO detection

        Returns:
            list of ComponentTerminal
        """
        self._counters = {}
        components = []

        for box in boxes:
            comp_id  = self._next_id(box.cls_name)
            terminal = self._make_terminal(comp_id, box)
            components.append(terminal)

        return components

    # ── Internal ─────────────────────────────────────────────────

    def _next_id(self, cls_name: str) -> str:
        prefix = REFDES_PREFIX.get(cls_name, "X")
        self._counters[prefix] = self._counters.get(prefix, 0) + 1
        n = self._counters[prefix]
        # Disambiguate multiple voltage sources
        if cls_name == "Ground":
            return f"GND{n}"
        return f"{prefix}{n}"

    def _make_terminal(self, comp_id: str, box: BoundingBox) -> ComponentTerminal:
        w = box.x2 - box.x1
        h = box.y2 - box.y1
        cx = (box.x1 + box.x2) // 2
        cy = (box.y1 + box.y2) // 2
        inset_x = int(w * self.pin_inset)
        inset_y = int(h * self.pin_inset)

        is_vertical = h > w * 1.3   # significantly taller than wide

        cls = box.cls_name

        # Special case: Battery/Voltage drawn as a circle is nearly square
        # (h/w ~1.0). Real schematics wire these top-to-bottom, so force
        # vertical when the aspect ratio is in the square zone (0.8 to 1.25).
        if cls in ("Battery", "Voltage", "AC Source"):
            ratio = h / w if w > 0 else 1.0
            if 0.8 <= ratio <= 1.25:
                is_vertical = True

        # ── Ground: single terminal at top-center ────────────────
        if cls == "Ground":
            pins = [Pin("GND", cx, box.y1 + inset_y)]

        # ── Diode: left = anode, right = cathode ─────────────────
        elif cls == "Diode":
            if is_vertical:
                pins = [
                    Pin("anode",   cx, box.y1 + inset_y),
                    Pin("cathode", cx, box.y2 - inset_y),
                ]
            else:
                pins = [
                    Pin("anode",   box.x1 + inset_x, cy),
                    Pin("cathode", box.x2 - inset_x, cy),
                ]

        # ── Battery / Voltage: left = negative, right = positive ─
        elif cls in ("Battery", "Voltage", "AC Source"):
            if is_vertical:
                pins = [
                    Pin("+", cx, box.y1 + inset_y),
                    Pin("-", cx, box.y2 - inset_y),
                ]
            else:
                pins = [
                    Pin("-", box.x1 + inset_x, cy),
                    Pin("+", box.x2 - inset_x, cy),
                ]

        # ── Standard 2-terminal: A (left) and B (right) ──────────
        else:  # Resistor, Capacitor, Inductor
            if is_vertical:
                pins = [
                    Pin("A", cx, box.y1 + inset_y),
                    Pin("B", cx, box.y2 - inset_y),
                ]
            else:
                pins = [
                    Pin("A", box.x1 + inset_x, cy),
                    Pin("B", box.x2 - inset_x, cy),
                ]

        return ComponentTerminal(
            component_id = comp_id,
            cls_name     = cls,
            box          = box,
            pins         = pins,
        )


# ── Visualization Helper ─────────────────────────────────────────

def visualize_terminals(image, components: List[ComponentTerminal]):
    """Draw component terminals on image."""
    import cv2
    vis = image.copy()

    PIN_COLORS = {
        "A"      : (255, 200,   0),
        "B"      : (255, 100,   0),
        "+"      : (  0, 255,   0),
        "-"      : (  0,   0, 255),
        "anode"  : (  0, 255,   0),
        "cathode": (  0,   0, 255),
        "GND"    : (100, 100, 255),
    }

    for comp in components:
        # Draw bounding box
        cv2.rectangle(vis,
                      (comp.box.x1, comp.box.y1),
                      (comp.box.x2, comp.box.y2),
                      (200, 200, 200), 1)

        # Label component
        cv2.putText(vis, comp.component_id,
                    (comp.box.x1, comp.box.y1 - 8),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                    (255, 255, 255), 1, cv2.LINE_AA)

        # Draw pins
        for pin in comp.pins:
            color = PIN_COLORS.get(pin.name, (255, 255, 0))
            cv2.circle(vis, (pin.x, pin.y), 5, color, -1)
            cv2.circle(vis, (pin.x, pin.y), 5, (255,255,255), 1)
            cv2.putText(vis, pin.name,
                        (pin.x + 6, pin.y + 4),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.35,
                        color, 1, cv2.LINE_AA)

    return vis


# ── Standalone test ───────────────────────────────────────────────
if __name__ == "__main__":
    # Simulate some detected boxes
    test_boxes = [
        BoundingBox(50,  100, 150, 140, "Resistor",  0.95),
        BoundingBox(200, 100, 300, 140, "Capacitor", 0.90),
        BoundingBox(350,  80, 450, 160, "Battery",   0.88),
        BoundingBox(500, 120, 560, 200, "Diode",     0.92),
        BoundingBox(250, 220, 300, 280, "Ground",    0.97),
    ]

    extractor  = TerminalExtractor()
    components = extractor.extract(test_boxes)

    for comp in components:
        print(f"\n{comp.component_id} ({comp.cls_name})")
        for pin in comp.pins:
            print(f"  {pin.name}: ({pin.x}, {pin.y})")

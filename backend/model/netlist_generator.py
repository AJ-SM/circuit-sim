"""
Stage 4+5 — Netlist Generator
================================
Takes connectivity result and generates:
  1. SPICE netlist (.cir) — for LTspice / Ngspice simulation
  2. JSON graph (.json)   — for custom use / web apps

User is prompted to enter component values interactively.

SPICE format:
  R1 N001 GND 1k
  C1 VCC N001 10u
  V1 VCC GND DC 5
  .tran 1m 10m
  .end
"""

import json
from dataclasses import dataclass, field
from typing import List, Dict, Optional
from pathlib import Path
from datetime import datetime

from terminal_extractor import ComponentTerminal
from connectivity_graph import ConnectivityResult, Net


# ── SPICE Value Defaults (fallback if user skips) ────────────────

DEFAULT_VALUES = {
    "Resistor"  : "1k",
    "Capacitor" : "10u",
    "Inductor"  : "1m",
    "Diode"     : "",        # Diodes use model name, not value
    "Battery"   : "DC 5",
    "Voltage"   : "DC 5",
    "AC Source" : "AC 1 SIN(0 5 1k)",
    "Ground"    : "",        # Ground has no value
}

# SPICE element type prefix per class
SPICE_PREFIX = {
    "Resistor"  : "R",
    "Capacitor" : "C",
    "Inductor"  : "L",
    "Diode"     : "D",
    "Battery"   : "V",
    "Voltage"   : "V",
    "AC Source" : "V",
}

# Diode model name
DIODE_MODEL = "1N4148"


# ── Data Types ────────────────────────────────────────────────────

@dataclass
class NetlistEntry:
    ref_des  : str    # e.g. "R1"
    cls_name : str    # e.g. "Resistor"
    net_pos  : str    # positive/A terminal net name
    net_neg  : str    # negative/B terminal net name
    value    : str    # e.g. "1k", "10u", "DC 5"

    def to_spice_line(self) -> str:
        if self.cls_name == "Diode":
            return f"{self.ref_des} {self.net_pos} {self.net_neg} {DIODE_MODEL}"
        return f"{self.ref_des} {self.net_pos} {self.net_neg} {self.value}"


@dataclass
class Netlist:
    entries          : List[NetlistEntry] = field(default_factory=list)
    nets             : List[Net]          = field(default_factory=list)
    title            : str = "Hand-drawn Circuit"
    timestamp        : str = ""
    # Spatial metadata for frontend rendering (set by circuit_pipeline)
    image_width      : int  = 0
    image_height     : int  = 0
    component_details: list = field(default_factory=list)  # bbox + pins per component

    def to_spice(self) -> str:
        lines = []
        lines.append(f"* {self.title}")
        lines.append(f"* Generated: {self.timestamp}")
        lines.append(f"* Nets: {', '.join(n.net_id for n in self.nets)}")
        lines.append("")

        for cls in ["Voltage", "Battery", "AC Source", "Resistor",
                    "Capacitor", "Inductor", "Diode"]:
            group = [e for e in self.entries if e.cls_name == cls]
            if group:
                lines.append(f"* --- {cls}s ---")
                for entry in group:
                    lines.append(entry.to_spice_line())
                lines.append("")

        lines.append("* --- Analysis ---")
        has_ac = any(e.cls_name == "AC Source" for e in self.entries)
        if has_ac:
            lines.append(".ac dec 10 1 10Meg")
        lines.append(".tran 1u 1m")
        lines.append(".op")
        lines.append("")
        lines.append(".end")
        return "\n".join(lines)

    def to_json_dict(self) -> dict:
        # CircuitJS uses a 16px grid; compute scale factors so the frontend
        # can map image-pixel pin positions → CircuitJS grid coordinates.
        CIRCUITJS_GRID = 16
        scale_x = round(CIRCUITJS_GRID / self.image_width,  6) if self.image_width  else 1.0
        scale_y = round(CIRCUITJS_GRID / self.image_height, 6) if self.image_height else 1.0

        return {
            "title"    : self.title,
            "timestamp": self.timestamp,
            "image": {
                "width" : self.image_width,
                "height": self.image_height,
            },
            # Grid metadata — frontend uses this to scale pin (x,y) → CircuitJS coords:
            #   cjs_x = round(pin.x * scale_x / grid_size) * grid_size
            #   cjs_y = round(pin.y * scale_y / grid_size) * grid_size
            "grid": {
                "circuitjs_grid": CIRCUITJS_GRID,
                "scale_x": scale_x,
                "scale_y": scale_y,
            },
            # Nets: each net lists ALL connected pins — frontend draws
            # wires directly between the pin positions within each net.
            "nets": [
                {
                    "id"  : net.net_id,
                    "pins": net.pin_uids,
                }
                for net in self.nets
            ],
            "components": [
                {
                    "ref_des"   : e.ref_des,
                    "type"      : e.cls_name,
                    "value"     : e.value,
                    "net_pos"   : e.net_pos,
                    "net_neg"   : e.net_neg,
                    "spice_line": e.to_spice_line(),
                }
                for e in self.entries
            ],
            "component_details": self.component_details,
        }


# ── Netlist Generator ─────────────────────────────────────────────

class NetlistGenerator:
    def __init__(self, interactive: bool = True):
        """
        Args:
            interactive: if True, prompt user for component values.
                         if False, use default values silently.
        """
        self.interactive = interactive

    def generate(
        self,
        components  : List[ComponentTerminal],
        conn_result : ConnectivityResult,
        title       : str = "Hand-drawn Circuit",
    ) -> Netlist:
        """
        Generate SPICE netlist and JSON from connectivity result.

        Args:
            components  : list of ComponentTerminal
            conn_result : ConnectivityResult from connectivity_graph
            title       : title string for the netlist header

        Returns:
            Netlist object with .to_spice() and .to_json_dict() methods
        """
        entries = []
        pin_to_net = conn_result.pin_to_net

        if self.interactive:
            print("\n" + "="*55)
            print("  COMPONENT VALUE ENTRY")
            print("  Press Enter to use default value shown in [brackets]")
            print("="*55)

        for comp in components:
            cls = comp.cls_name

            # Skip ground — it's just a net reference, not an element
            if cls == "Ground":
                continue

            # Get pin net names
            net_pos, net_neg = self._get_pin_nets(comp, pin_to_net)

            # Skip floating components (not connected to any net)
            if net_pos == "?" and net_neg == "?":
                print(f"  [WARN] {comp.component_id} ({cls}) is not connected — skipping")
                continue

            # Get component value
            value = self._get_value(comp)

            entries.append(NetlistEntry(
                ref_des  = comp.component_id,
                cls_name = cls,
                net_pos  = net_pos,
                net_neg  = net_neg,
                value    = value,
            ))

        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        return Netlist(
            entries   = entries,
            nets      = conn_result.nets,
            title     = title,
            timestamp = timestamp,
        )

    # ── Internal ─────────────────────────────────────────────────

    def _get_pin_nets(
        self,
        comp      : ComponentTerminal,
        pin_to_net: Dict[str, str],
    ):
        """Return (net_positive, net_negative) for a component."""
        nets = {}
        for pin in comp.pins:
            uid = f"{comp.component_id}.{pin.name}"
            nets[pin.name] = pin_to_net.get(uid, "?")

        cls = comp.cls_name

        if cls == "Diode":
            return nets.get("anode", "?"), nets.get("cathode", "?")
        elif cls in ("Battery", "Voltage", "AC Source"):
            return nets.get("+", "?"), nets.get("-", "?")
        else:
            # Standard 2-terminal: A → positive, B → negative
            return nets.get("A", "?"), nets.get("B", "?")

    def _get_value(self, comp: ComponentTerminal) -> str:
        """Prompt user for component value or use default."""
        cls     = comp.cls_name
        default = DEFAULT_VALUES.get(cls, "1")

        if not self.interactive or cls in ("Ground", "Diode"):
            return default

        # Build prompt
        examples = {
            "Resistor"  : "e.g. 1k, 4.7k, 220",
            "Capacitor" : "e.g. 10u, 100n, 1p",
            "Inductor"  : "e.g. 1m, 100u, 10n",
            "Battery"   : "e.g. 5, 9, 12",
            "Voltage"   : "e.g. DC 5, DC 3.3",
            "AC Source" : "e.g. AC 1 SIN(0 5 1k)",
        }
        hint = examples.get(cls, "")

        print(f"\n  {comp.component_id} ({cls})  [{hint}]")
        raw = input(f"    Value [{default}]: ").strip()

        if not raw:
            return default

        # For Battery/Voltage, prefix with "DC" if user just typed a number
        if cls in ("Battery", "Voltage") and raw.replace(".", "").isdigit():
            return f"DC {raw}"

        return raw


# ── File Writers ─────────────────────────────────────────────────

def save_netlist(netlist: Netlist, output_dir: Path, base_name: str = "netlist"):
    """Save SPICE .cir and JSON files to output_dir."""
    output_dir.mkdir(parents=True, exist_ok=True)

    # SPICE netlist
    spice_path = output_dir / f"{base_name}.cir"
    with open(spice_path, "w", encoding="utf-8") as f:
        f.write(netlist.to_spice())

    # JSON graph
    json_path = output_dir / f"{base_name}.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(netlist.to_json_dict(), f, indent=2)

    return spice_path, json_path


# ── Standalone test ───────────────────────────────────────────────
if __name__ == "__main__":
    from connectivity_graph import Net, ConnectivityResult, PinRef

    # Simulate a simple circuit: R1 between VCC and N001, C1 between N001 and GND
    from wire_detector import BoundingBox
    from terminal_extractor import TerminalExtractor

    boxes = [
        BoundingBox(50, 100, 150, 140, "Resistor", 0.95),
        BoundingBox(200, 100, 300, 140, "Capacitor", 0.90),
        BoundingBox(350, 80,  430, 160, "Battery",   0.88),
        BoundingBox(200, 220, 250, 280, "Ground",    0.97),
    ]

    extractor  = TerminalExtractor()
    components = extractor.extract(boxes)

    # Fake connectivity: R1.A=VCC, R1.B=N001, C1.A=N001, C1.B=GND, V1.+=VCC, V1.-=GND
    pin_to_net = {
        "R1.A": "VCC", "R1.B": "N001",
        "C1.A": "N001", "C1.B": "GND",
        "V1.+": "VCC", "V1.-": "GND",
        "GND1.GND": "GND",
    }

    net_gnd = Net("GND"); net_gnd.pin_refs = {PinRef("GND1","GND",225,250), PinRef("C1","B",300,120), PinRef("V1","-",355,140)}
    net_vcc = Net("VCC"); net_vcc.pin_refs = {PinRef("R1","A",50,120), PinRef("V1","+",425,120)}
    net_n1  = Net("N001");net_n1.pin_refs  = {PinRef("R1","B",150,120), PinRef("C1","A",200,120)}

    conn = ConnectivityResult(
        nets       = [net_gnd, net_vcc, net_n1],
        pin_to_net = pin_to_net,
        unmatched_pts = [],
    )

    gen     = NetlistGenerator(interactive=False)
    netlist = gen.generate(components, conn, title="Test RC Circuit")

    print("\n" + "="*50)
    print("SPICE NETLIST:")
    print("="*50)
    print(netlist.to_spice())

    import tempfile
    with tempfile.TemporaryDirectory() as tmpdir:
        sp, js = save_netlist(netlist, Path(tmpdir))
        print(f"\nSaved: {sp}")
        print(f"Saved: {js}")

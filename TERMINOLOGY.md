# Circuit Simulation Platform: Core Project Terminology & Architecture Guide

This document provides a comprehensive reference of all engineering, scientific, and architectural terminologies used across this project (`circuit-sim`). It is intended to guide current and future developers on how the system models, simulates, detects, and visualizes electronic circuits.

---

## Table of Contents
1. [Electrical Engineering & Physics Fundamentals](#1-electrical-engineering--physics-fundamentals)
2. [SPICE Simulation Engine Concepts](#2-spice-simulation-engine-concepts)
3. [Frontend Schematic & Visualization Architecture](#3-frontend-schematic--visualization-architecture)
4. [AI, Computer Vision & Netlist Extraction](#4-ai-computer-vision--netlist-extraction)
5. [Coordinate Systems & Spatial Geometry](#5-coordinate-systems--spatial-geometry)
6. [Data Models & Schema Reference](#6-data-models--schema-reference)

---

## 1. Electrical Engineering & Physics Fundamentals

### 1.1 Netlist
* **Definition**: A structured, machine-readable textual representation of an electrical circuit diagram that describes the components, their parameters, and the nodes connecting them.
* **In this project**: 
  - The frontend constructs a Netlist JSON object via `buildNetlist()` in [`frontend/src/domain/netlist.ts`](file:///c:/Users/varad/OneDrive/Desktop/product/circuit-sim/frontend/src/domain/netlist.ts).
  - The backend converts this Netlist into a standard SPICE deck in [`backend/main.py`](file:///c:/Users/varad/OneDrive/Desktop/product/circuit-sim/backend/main.py).

### 1.2 Node (or Net)
* **Definition**: An idealized, equipotential junction or wire network connecting two or more component terminals. According to Kirchhoff's laws, every point on a single net shares the exact same electrical potential.
* **SPICE Convention**: Nodes are numbered or named strings (e.g., `"1"`, `"2"`, `"net_a"`).

### 1.3 Ground Reference (GND / Node "0")
* **Definition**: The designated zero-volt reference point ($0.00\text{ V}$) of the entire circuit against which all other node voltages are measured.
* **SPICE Rule**: SPICE strictly requires the reference node to be named **`0`**.
* **Zero Clamping in our system**: Any node connected to a Ground component or with $|V| < 1\text{ mV}$ is snapped to exactly `0.00 V` (`_ZERO_SNAP = 1e-3`) to prevent floating numerical noise (e.g., displaying `5.0 mV` instead of `0.00 V`).

### 1.4 Node Voltage ($V_{\text{node}}$)
* **Definition**: The electric potential at a given node measured relative to Ground ($V - V_{\text{GND}}$).
* **Visualization Convention**:
  - `0.00 V` (GND) $\rightarrow$ Cool Cyan / Blue (`#38bdf8`)
  - Intermediate $+V$ $\rightarrow$ Phosphor Green (`#6effb0`)
  - High $+V$ $\rightarrow$ Warm Amber / Orange (`#ffb454`)
  - Peak $+V$ $\rightarrow$ Warm Red (`#f87171`)

### 1.5 Branch & Branch Voltage ($\Delta V$)
* **Definition**: A path between two circuit nodes containing a single two-terminal component (e.g., resistor, capacitor, voltage source).
* **Branch Voltage ($\Delta V$)**: The potential difference across the component terminals:
  $$\Delta V = V_a - V_b$$
  where $V_a$ is the potential at Pin A and $V_b$ is the potential at Pin B.

### 1.6 Branch Current ($I$) & Sign Conventions
* **Passive Sign Convention (PSC)**:
  - Applied to passive components (resistors, capacitors, inductors).
  - Current is defined as positive when it enters the terminal with higher potential and exits the terminal with lower potential ($a \rightarrow b$ when $V_a > V_b$):
    $$I = \frac{V_a - V_b}{R} = \frac{\Delta V}{R}$$
* **Active Sign Convention (Power Sources)**:
  - Conventional electric current flows *out* of the positive terminal ($+$) of a voltage source into the external circuit.
  - **ngspice Trapping**: ngspice's raw `v#branch` monitors current entering the positive terminal. Our backend negates this value (`current = -raw_i`) so that reported current matches standard textbook physics (conventional current exiting the positive terminal).
* **Current Visualization**:
  - Magnitude is displayed as an absolute value ($|I|$) in Amperes, Milliamperes ($\text{mA}$), or Microamperes ($\mu\text{A}$).
  - Flow direction is conveyed strictly by animated dashes and midpoint arrowheads ($a \rightarrow b$ vs. $b \rightarrow a$).

---

## 2. SPICE Simulation Engine Concepts

### 2.1 ngspice
* An open-source, industry-standard mixed-level / mixed-signal circuit simulator based on Berkeley SPICE 3f5.
* In this project, `backend/main.py` invokes `ngspice -b <deck.cir>` in batch/headless mode, capturing standard output and parsing operating points.

### 2.2 SPICE Deck
* The plain-text formatted script executed by ngspice.
* Standard syntax:
  - Resistor: `R1 <nodeA> <nodeB> <resistance>`
  - Capacitor: `C1 <nodeA> <nodeB> <capacitance>`
  - Inductor: `L1 <nodeA> <nodeB> <inductance>`
  - DC Voltage Source: `V1 <nodeA> <nodeB> DC <volts>`
  - Model definitions: `.model DMOD D(...)`
  - Directive: `.op` (DC Operating Point) or `.tran` (Transient)
  - Terminator: `.end`

### 2.3 Analysis Modes
* **DC Operating Point (`.op`)**:
  - Calculates the steady-state DC voltages and currents of the circuit. Capacitors become open circuits ($\infty\ \Omega$) and inductors become short circuits ($0\ \Omega$).
* **Transient Analysis (`.tran`)**:
  - Simulates time-varying response over a specified time window with discrete time steps (`stepSeconds`, `stopSeconds`).
* **AC Sweep (`.ac`)**:
  - Small-signal frequency-domain response analyzed across a sweep of frequencies.

---

## 3. Frontend Schematic & Visualization Architecture

### 3.1 Schematic Canvas
* Infinite zoomable and pannable SVG workspace rendered in [`frontend/src/canvas/SchematicCanvas.tsx`](file:///c:/Users/varad/OneDrive/Desktop/product/circuit-sim/frontend/src/canvas/SchematicCanvas.tsx).
* Handles mouse wheel zooming, pointer panning, component dragging, and wire routing.

### 3.2 Reference Designator (`refId`)
* The unique schematic alphanumeric label assigned to a component according to IEEE standard prefixes:
  - `R1`, `R2` $\rightarrow$ Resistors
  - `C1`, `C2` $\rightarrow$ Capacitors
  - `L1`, `L2` $\rightarrow$ Inductors
  - `V1`, `V2` $\rightarrow$ Independent Voltage Sources
  - `D1`, `D2` $\rightarrow$ Diodes
  - `GND1` $\rightarrow$ Ground Symbols

### 3.3 Pin & PinRef
* **Pin (`PinDef`)**: A connection terminal on a component definition with local coordinates relative to the component center.
* **PinRef**: A reference pointing to a specific pin of a placed component: `{ componentId: string, pinId: string }`.
* **Pin Direction (`pinDirection`)**: Outward unit vector (`{x, y}`) pointing away from the component body, used for wire stub escapes and badge collision avoidance.

### 3.4 Orthogonal (Manhattan) Wire Routing
* Automated routing algorithm in [`frontend/src/utils/geometry.ts`](file:///c:/Users/varad/OneDrive/Desktop/product/circuit-sim/frontend/src/utils/geometry.ts) (`orthogonalPath` / `routedPath`) that routes connections strictly using horizontal and vertical segments with $90^\circ$ corners.
* **Longest Segment Midpoint**: In [`frontend/src/canvas/WireView.tsx`](file:///c:/Users/varad/OneDrive/Desktop/product/circuit-sim/frontend/src/canvas/WireView.tsx), current badges and arrows are positioned on the segment with the greatest length to guarantee they never collide with pin connection dots or wire corner elbows.

### 3.5 Analysis Overlay & Voltage Pills
* Renders node potential badges at pin world coordinates ([`frontend/src/canvas/AnalysisOverlay.tsx`](file:///c:/Users/varad/OneDrive/Desktop/product/circuit-sim/frontend/src/canvas/AnalysisOverlay.tsx)).
* **Collision Avoidance Rules**:
  - **Horizontal pins**: Badge offset 20px above the terminal dot (at least 12px clear from the wire line) with horizontal bias away from the component body.
  - **Vertical pins**: Badge offset 14px to the left of the terminal point with clear horizontal padding.
  - **Ground pins**: Badge offset 16px to the side, preventing overlap with ground spikes.

### 3.6 Branch Info Overlay (Component Popup)
* An interactive popup card toggled on click ([`frontend/src/canvas/ComponentView.tsx`](file:///c:/Users/varad/OneDrive/Desktop/product/circuit-sim/frontend/src/canvas/ComponentView.tsx)) displaying:
  - $\Delta V$ magnitude and unit
  - Current magnitude $I$
  - Direction chip arrow ($\rightarrow$ or $\leftarrow$)
* **Placement**:
  - **Horizontal parts**: Centered directly beneath the component ($y = +28\text{px}$), leaving the top free for `R1` and pin badges.
  - **Vertical parts**: Placed alongside the component to the right ($x = +28\text{px}$), leaving the left free for pin badges.

### 3.7 Animated Flow Dashes
* Dynamic SVG `stroke-dasharray` animation representing current flow.
* **Speed (`flowSpeed`)**:
  - Fast ($0.25\text{s} - 0.4\text{s}$): $I \ge 10\text{ mA}$
  - Moderate ($0.7\text{s}$): $1\text{ mA} \le I < 10\text{ mA}$
  - Gentle ($1.2\text{s}$): $I < 1\text{ mA}$
  - Static (no movement): $I = 0\text{ A}$

---

## 4. AI, Computer Vision & Netlist Extraction

### 4.1 YOLO Circuit Detector (`circuit_detector_v2_best.pt`)
* A custom-trained Ultralytics YOLO convolutional neural network residing in `backend/model/`.
* Takes an uploaded image or hand-drawn sketch and outputs predicted bounding boxes and classes (`resistor`, `capacitor`, `vsource_dc`, `ground`, etc.).

### 4.2 Drawn Topology Pipeline (`drawn_topology.py`)
* Converts a binary/raster drawing into a vectorized circuit topology graph:
  1. **Binarization & Thinning**: Morphological skeletonization reducing strokes to 1-pixel-wide centerlines.
  2. **Junction Detection**: Identifies T-junctions, cross-junctions, and terminal endpoints using 8-neighborhood pixel connectivity.
  3. **Terminal Extractor**: Associates wire stroke ends with component bounding box terminals.
  4. **Graph Simplification**: Merges adjacent nodes within a pixel tolerance into a clean connectivity graph.

### 4.3 Value Reader / OCR (`value_reader.py`)
* Subsystem using Optical Character Recognition (EasyOCR / TrOCR) to read handwritten labels (e.g., `10k`, `100uF`, `12V`) adjacent to detected component boxes and parse them into standard floating-point SI values.

---

## 5. Coordinate Systems & Spatial Geometry

### 5.1 Grid Units vs. Screen Pixels
* **Grid Constant**: `GRID_SIZE = 24` pixels.
* All schematic component positions $(x, y)$, pin offsets, and wire waypoints are stored in **integer grid units**.
* Pixel coordinates are calculated on the fly:
  $$\text{pixel} = \text{grid} \times \text{GRID\_SIZE}$$

### 5.2 Rotations & Mirroring
* **Rotation**: Integer degrees clockwise ($0^\circ, 45^\circ, 90^\circ, 135^\circ, 180^\circ, 225^\circ, 270^\circ, 315^\circ$).
* **Axis Scaling (`axisScale`)**: Diagonal rotations ($45^\circ$, $135^\circ$, etc.) multiply coordinates by $\sqrt{2}$ so pins align onto integer grid intersections.
* **Mirroring**: Flips the component's local $X$-axis before applying rotation matrix transformations.

---

## 6. Data Models & Schema Reference

### 6.1 `ComponentInstance` (Frontend)
```typescript
interface ComponentInstance {
  id: string;                    // UUID
  kind: ComponentKind;           // "resistor" | "capacitor" | "vsource_dc" | ...
  refId: string;                 // "R1", "V1", etc.
  x: number;                     // Grid X coordinate
  y: number;                     // Grid Y coordinate
  rotation: Rotation;            // 0 | 45 | 90 | 180 | 270 ...
  mirrored: boolean;             // Horizontal flip
  params: Record<string, number>;// { resistance: 1000 }
}
```

### 6.2 `Wire` (Frontend)
```typescript
interface Wire {
  id: string;                    // UUID
  from: PinRef;                  // { componentId, pinId }
  to: PinRef;                    // { componentId, pinId }
  waypoints?: { x: number; y: number }[];
  route?: WireRoute;             // User-dragged custom axis position
}
```

### 6.3 `BranchInfo` (Backend & Frontend API)
```typescript
interface BranchInfo {
  component_id: string;          // Target component UUID
  ref: string;                   // "R1", "V1"
  type: string;                  // "resistor", "vsource_dc"
  node_a: string;                // Net name of Pin 1 (e.g. "1")
  node_b: string;                // Net name of Pin 2 (e.g. "0")
  voltage_a: number;             // Potential at Pin 1 in Volts
  voltage_b: number;             // Potential at Pin 2 in Volts
  delta_v: number;               // Potential difference: Va - Vb
  current_a: number;             // Branch current in Amperes
  direction: "a_to_b" | "b_to_a" | "none"; // Conventional flow direction
}
```

---

## 7. Developer Quick Reference

* **Add a new component kind**:
  1. Add kind string to [`frontend/src/types/circuit.ts`](file:///c:/Users/varad/OneDrive/Desktop/product/circuit-sim/frontend/src/types/circuit.ts) (`ComponentKind`).
  2. Define pins, dimensions, and default parameters in [`frontend/src/domain/componentDefs.ts`](file:///c:/Users/varad/OneDrive/Desktop/product/circuit-sim/frontend/src/domain/componentDefs.ts).
  3. Register SVG artwork in [`frontend/src/canvas/symbols.tsx`](file:///c:/Users/varad/OneDrive/Desktop/product/circuit-sim/frontend/src/canvas/symbols.tsx).
  4. Add SPICE deck translation mapping in [`backend/main.py`](file:///c:/Users/varad/OneDrive/Desktop/product/circuit-sim/backend/main.py) (`_TYPE_TO_SPICE` and `_build_spice_deck`).
* **Modify simulation thresholds**:
  - Backend zero voltage snap threshold: `_ZERO_SNAP` in `backend/main.py`.
  - Frontend display voltage clamp: `fmtVolts` in `AnalysisOverlay.tsx` and `SimulationPanel.tsx`.

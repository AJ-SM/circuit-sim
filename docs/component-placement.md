# Component Placement: Netlist JSON → Schematic Canvas

How the frontend decides where each component goes (its `x`, `y`, `rotation` and `mirrored`) when a netlist JSON is loaded. That JSON comes from `/generate-circuit`, **Load Image** or **Load Netlist**.

All of this lives in [`frontend/src/utils/loadNetlistJson.ts`](../frontend/src/utils/loadNetlistJson.ts). The store calls it from `loadNetlist()` in [`frontend/src/store/circuitStore.ts`](../frontend/src/store/circuitStore.ts).

---

## Contents

1. [Coordinate systems](#1-coordinate-systems)
2. [Input: what the backend provides](#2-input-what-the-backend-provides)
3. [Pipeline overview](#3-pipeline-overview)
4. [Choosing a layout strategy](#4-choosing-a-layout-strategy)
5. [Photo layout: pixels to grid](#5-photo-layout-pixels-to-grid)
6. [Orientation: rotation and mirroring](#6-orientation-rotation-and-mirroring)
7. [Fallback layouts](#7-fallback-layouts)
8. [Wires](#8-wires)
9. [Worked example](#9-worked-example)
10. [Constants and tuning](#10-constants-and-tuning)
11. [Known limitations](#11-known-limitations)
12. [Code reference](#12-code-reference)

---

## 1. Coordinate systems

| Space | Unit | Where it's used |
|---|---|---|
| **Image space** | Pixels of the image sent to the backend (a drawing is exported with its long side at 1600 px) | Every coordinate in `component_details` and `wires` |
| **Grid space** | Grid units (integers after snapping) | `ComponentInstance.x / y` and everything stored in the circuit |
| **Screen space** | CSS pixels: `grid × GRID_SIZE` (24 px per unit, in `utils/geometry.ts`), then pan/zoom | Rendering only |

The loader's job is to map **image space to grid space**.

---

## 2. Input: what the backend provides

Each entry of `component_details` carries the geometry used for placement:

```json
{
  "ref_des": "R1",
  "type": "Resistor",
  "bbox": { "x1": 740, "y1": 150, "x2": 860, "y2": 270, "cx": 800, "cy": 210 },
  "pins": [
    { "name": "A", "x": 650, "y": 200, "net_id": "N1" },
    { "name": "B", "x": 950, "y": 220, "net_id": "N2" }
  ]
}
```

| Field | Produced by | Meaning |
|---|---|---|
| `bbox` | YOLO detector (`backend/recognizer.py`) | Symbol bounding box. `cx, cy` is its centre |
| `pins[].x / y` | Ink-based topology (`backend/drawn_topology.py`) | Where the wire ink meets the symbol |
| `pins[].net_id` | Connectivity (`backend/drawn_topology.py`) | Which net the pin belongs to |

`components[]` also gives `net_pos` / `net_neg` for each part. The topology fallback uses these (§7).

---

## 3. Pipeline overview

```
netlist JSON
   │
   ├─ 1. bridgeSkippedComponentNets   unsupported parts (e.g. LEDs, switches) become shorts
   ├─ 2. typeToKind                   "Resistor" → resistor, "Voltage" → vsource_dc,
   │                                  "Transistor" + subtype → bjt_npn / bjt_pnp, "Op-Amp" → opamp
   ├─ 3. choose layout strategy       photo / topology / auto-grid       (§4)
   ├─ 4. position + orient each part                                     (§5, §6, §7)
   ├─ 5. build wires from net ids                                        (§8)
   ├─ 6. resolveWireOverlaps          non-photo layouts only
   └─ 7. map raw ink segments to grid  faint background trace layer
   ▼
{ components, wires, skipped, rawWireSegments, rawJunctions }
```

Every placed part starts at `x = 0, y = 0, rotation = 0, mirrored = false`. Steps 3 and 4 then fill in the real values.

---

## 4. Choosing a layout strategy

`loadNetlistJson()` picks **one** strategy for the whole circuit:

| Priority | Strategy | Condition | Result |
|---|---|---|---|
| a | **Photo layout** (normal case) | Every placed part has pins in `component_details` | Reproduces the drawing (§5) |
| b | **Topology layout** | Some part lacks geometry, but `net_pos` / `net_neg` exist | A clean rectangular loop (§7.1) |
| c | **Auto-grid** | Neither of the above (old minimal JSON) | A 4-column grid (§7.2) |

The code checks (b) first: `!hasFullGeometry && hasNetTopology`. That way, one part with missing pins doesn't produce a half-photo, half-guessed layout.

---

## 5. Photo layout: pixels to grid

Implemented by `buildPixelToGrid()`. It returns a transform, `toGridClustered(px, py)`, that is applied to each part's **bbox centre**.

### 5.1 Collect the coordinates

All x and y values are gathered from every detail: each bbox centre (`cx`, `cy`) and each pin (`x`, `y`). They decide the clusters and the extents.

### 5.2 Cluster nearby values (rail alignment)

A hand-drawn rail is never perfectly straight. Two resistors on the same top wire might have their centres at y = 205 and y = 231. Clustering merges such values so the parts land exactly in line.

`clusterValues(values, tolerance)`:
1. Sort the unique values.
2. Starting from the smallest (the seed), take every following value within `tolerance` **of the seed**.
3. Replace each value in that group with the group's median, `group[floor(n/2)]`.
4. Continue from the first value outside the group.

x and y are clustered **independently**.

```
values    = [1497, 1534, 800], tolerance = 50
clusters  = [800] → 800,  [1497, 1534] → 1534   (group[floor(2/2)] = group[1])
```

**Tolerance**, from `clusterTolerancePx()`:

```
tolerance = min(50 px, 0.3 × median two-pin part length in px)
```

On a small image, 50 px could be nearly a whole part. Without the cap, both ends of a short part would merge into one point.

### 5.3 Compute the scale

```
innerW = TARGET_W − 2 × CANVAS_MARGIN = 26 − 8 = 18 grid units
innerH = TARGET_H − 2 × CANVAS_MARGIN = 22 − 8 = 14 grid units

rangeX = max(clustered x) − min(clustered x)     (1 if zero)
rangeY = max(clustered y) − min(clustered y)     (1 if zero)

scale = max( min(innerW / rangeX, innerH / rangeY),   ← fit the drawing in the area
             MIN_GRID_PER_PART / medianPartLengthPx ) ← parts stay ≥ 3 grid units long
```

- **Uniform:** the same scale is used on both axes, so the drawing's proportions are kept.
- **Minimum size:** a crowded drawing still gets readable spacing. It may then grow past the 26 × 22 area, and the canvas pans to show it.

### 5.4 Compute the offset to centre it

```
offsetX = CANVAS_MARGIN + max(0, (innerW − rangeX × scale) / 2) − minX × scale
offsetY = CANVAS_MARGIN + max(0, (innerH − rangeY × scale) / 2) − minY × scale
```

The drawing is centred in the target area. A drawing larger than the area starts at the margin (the `max(0, …)` term).

### 5.5 Map and snap

For each part:

```
(cx', cy') = clustered (bbox.cx, bbox.cy)
x = snap(cx' × scale + offsetX)
y = snap(cy' × scale + offsetY)
```

`snap()` is `Math.round`, so every part lands on an integer grid point.

A part that has no detail entry (possible only in the mixed case) goes to `x = 6 + 6·index`, `y = 2`.

---

## 6. Orientation: rotation and mirroring

Every two-pin part is defined with **pin[0] at local (−1, 0)** and **pin[1] at local (+1, 0)**: horizontal, 2 grid units long, first pin on the left.

`applyPixelOrientation()` finds the two detected pins by name (for example `+`/`-` or `A`/`B`, matched to the definition's pin order). `computeOrientationFromPixels()` then looks at the direction from pin[0] to pin[1]:

```
dx = p2.x − p1.x,  dy = p2.y − p1.y
angle = atan2(dy, dx)          (screen angle, y grows downwards)
```

| Detected direction | Result |
|---|---|
| Within **±15°** of a diagonal, going right (`dx > 0`) | `rotation 45` (down-right) or `315` (up-right), not mirrored |
| Within ±15° of a diagonal, going left (`dx < 0`) | `rotation 315` (down-left) or `45` (up-left), **mirrored** |
| Mostly horizontal (`|dx| ≥ |dy|`) | `rotation 0`, mirrored if pin[0] is on the right (`dx < 0`) |
| Mostly vertical | `rotation 90` if pin[0] is on top (`dy > 0`), otherwise `270` |

Parts pointing left are **mirrored instead of rotated by 180°**, so the symbol artwork (text, the `+` sign) never ends up upside down.

A diagonal part puts its pins on the grid diagonal, so it is drawn √2 longer along its axis.

**Three-pin parts** (transistors, op-amps) use `applyMultiPinOrientation()` instead. For each of the four rotations, mirrored or not, it compares the direction of every definition pin from the part's centre with the direction of the matching detected pin from the bbox centre (cosine similarity, summed), and keeps the best. So a transistor drawn with its base on the right is mirrored, and an op-amp pointing left is turned 180°.

Pin names are matched case-insensitively, and the backend's ASCII `-` matches the op-amp's `−` pin (`normPinName`).

Parts with a single pin (**Ground**) keep `rotation 0`.

---

## 7. Fallback layouts

### 7.1 Topology layout: `traceSeriesChain` + `placeInLoop`

Used when geometry is incomplete but nets are known.

1. **`traceSeriesChain`** walks the circuit as a series loop. It starts at a voltage source when there is one, leaves through its `net_neg`, and moves to whichever unvisited part shares the current net. Parts it can't reach go at the end.
2. **`placeInLoop`** arranges the chain as a rectangle:
   - A single part goes to the centre, `(13, 11)`.
   - Otherwise the first half goes on a **top row**, left to right, 5 grid units apart. The rest goes on a **bottom row** 6 units lower, right to left, so the loop closes.
   - Each part is mirrored when needed so the pin wired to the previous part faces it. Otherwise the wire would have to loop back across the symbol.

### 7.2 Auto-grid: `autoLayout`

The last resort. Parts are placed in input order on a 4-column grid starting at `(6, 6)`, 6 units apart horizontally and 5 vertically. Orientation stays at its default.

### 7.3 Overlap resolution

After wiring, `resolveWireOverlaps()` tries other rotations and mirrors of the connected parts to clear wires that overlap. It runs **only for the fallback layouts**. In the photo layout, the orientation comes from the drawing and is kept as drawn.

---

## 8. Wires

Wires are **not** placed from the drawn ink. They are rebuilt from connectivity and routed between the placed pins:

| Priority | Builder | Source |
|---|---|---|
| 1 | `buildWiresFromPinNetIds` | Pins in `component_details` that share a `net_id` are chained together |
| 2 | `buildWiresFromNets` | The `nets[].pins` list (`"R1.A"`, `"V1.+"`) |
| 3 | `buildWiresFromSegments` | The raw ink segments, joined to pins by distance |

Each wire connects two pins (`from` / `to`) and is drawn as a right-angle path from the pins' grid positions.

The raw ink (`wires.segments`, `wires.junctions`) is also mapped with the same `toGridClustered` transform. This output (`rawWireSegments`, `rawJunctions`) is only a faint background trace showing what was drawn.

---

## 9. Worked example

A 1600 px drawing with a source on the left, a resistor across the top and a capacitor on the right:

| Part | bbox centre | pin[0] | pin[1] |
|---|---|---|---|
| V1 | (200, 500) | `+` (200, 350) | `-` (200, 650) |
| R1 | (800, 210) | `A` (650, 200) | `B` (950, 220) |
| C1 | (1400, 495) | `A` (1400, 345) | `B` (1410, 645) |

**Tolerance.** The part lengths are 300, 300.2 and 300.7 px, so the median is 300.2. The tolerance is min(50, 0.3 × 300.2) = **50 px**.

**Clustering.**
- x: `[200]`, `[650]`, `[800]`, `[950]`, `[1400, 1410] → 1410`
- y: `[200, 210, 220] → 210`, `[345, 350] → 350`, `[495, 500] → 500`, `[645, 650] → 650`

**Extents.** x runs from 200 to 1410 (range 1210). y runs from 210 to 650 (range 440).

**Scale.** min(18 / 1210, 14 / 440) = min(0.01488, 0.03182) = 0.01488. The minimum-size floor is 3 / 300.2 = 0.00999. So **scale = 0.01488** grid units per pixel.

**Offset.**
- offsetX = 4 + max(0, (18 − 18.0) / 2) − 200 × 0.01488 = **1.025**
- offsetY = 4 + (14 − 6.545) / 2 − 210 × 0.01488 = **4.603**

**Placement.**

| Part | Clustered centre | x | y | Orientation |
|---|---|---|---|---|
| V1 | (200, 500) | round(2.975 + 1.025) = **4** | round(7.438 + 4.603) = **12** | pins top→bottom → `rotation 90` |
| R1 | (800, 210) | round(11.901 + 1.025) = **13** | round(3.124 + 4.603) = **8** | dx 300, dy 20 → `rotation 0` |
| C1 | (1410, 500) | round(20.975 + 1.025) = **22** | round(7.438 + 4.603) = **12** | dx 10, dy 300 → `rotation 90` |

V1 and C1 end up on the same row (y = 12), even though their drawn centres differed by 5 px. That is the clustering at work. Three wires are then built from the net ids N1, N2 and N3.

> These numbers were produced by running the real `loadNetlistJson()` on this input.

---

## 10. Constants and tuning

| Constant | Value | Effect of increasing it |
|---|---|---|
| `TARGET_W` × `TARGET_H` | 26 × 22 grid units | The circuit is laid out larger |
| `CANVAS_MARGIN` | 4 grid units | More empty space around the circuit |
| `CLUSTER_TOLERANCE_PX` | 50 px | More values merge into the same rail. Too high and nearby parts collapse onto each other |
| Tolerance cap | 0.3 × median part length | Same as above, for small images |
| `MIN_GRID_PER_PART` | 3 grid units | More space between parts in crowded drawings |
| `DIAGONAL_TOLERANCE_DEG` | 15° | More slanted parts are treated as diagonal rather than straight |
| `GRID_SIZE` (`geometry.ts`) | 24 px | Larger on screen. Doesn't change the layout |

---

## 11. Known limitations

- **Position comes from the bbox centre, not the pins.** The symbol has a fixed length (2 grid units), so its pins may not land exactly where the drawn wire ends were. Wires are routed to the placed pins, so the circuit stays correct but can look slightly different from the drawing.
- **Rounding can stack parts.** Snapping to whole grid units, plus clustering, can put two very close parts on the same point. `MIN_GRID_PER_PART` reduces this but doesn't rule it out.
- **Clustering is seed-based.** A group grows only while values are within the tolerance of its first value, so a slowly sloping line of parts can split into several rails.
- **No overlap resolution in the photo layout.** If the drawing itself has crossing or overlapping wires, they stay that way.
- **One bad detail switches the whole layout.** If any placed part lacks pins, the whole circuit uses the topology loop layout and the drawn arrangement is lost.
- **Unsupported parts are bridged.** Kinds the canvas can't draw (`typeToKind` returns `null`) are skipped, and their two nets are merged, so the loop still closes. The parts are listed to the user afterwards.
- **Three-pin parts are drawn at their fixed size.** A transistor is 2 × 2 grid units and an op-amp 4 × 2.5, wherever the drawn symbol's pins were; wires are routed to the placed pins.

---

## 12. Code reference

All functions are in `frontend/src/utils/loadNetlistJson.ts` unless noted. Line numbers are as of this writing.

| Function / constant | Line | Role |
|---|---|---|
| `typeToKind` | 140 | Backend class name → `ComponentKind` |
| `normPinName`, `findPinDef` | 407 | Pin-name matching (`-` = `−`) |
| `bridgeSkippedComponentNets` | 230 | Merges nets across unsupported parts |
| `CANVAS_MARGIN`, `TARGET_W`, `TARGET_H` | 279 | Target layout area |
| `MIN_GRID_PER_PART` | 289 | Minimum part spacing |
| `medianPartLengthPx` | 292 | Typical drawn part length |
| `clusterTolerancePx` | 305 | Clustering tolerance |
| `clusterValues` | 325 | 1-D clustering |
| `buildPixelToGrid` | 350 | Scale, offset and snap transform |
| `DIAGONAL_TOLERANCE_DEG` | 431 | Diagonal detection |
| `computeOrientationFromPixels` | 433 | Rotation and mirroring from the pin direction |
| `applyPixelOrientation` | 459 | Applies it to an instance |
| `applyMultiPinOrientation` | 481 | Rotation and mirroring for transistors and op-amps |
| `autoLayout` | 515 | Grid fallback |
| `traceSeriesChain` | 547 | Loop order for the topology fallback |
| `placeInLoop` | 610 | Rectangle placement for the topology fallback |
| `buildWiresFromPinNetIds` | 663 | Primary wire builder |
| `buildWiresFromSegments` | 710 | Ink-segment wire builder |
| `buildWiresFromNets` | 787 | `nets[]` wire builder |
| `resolveWireOverlaps` | 906 | Re-orients parts to clear wires (fallback layouts only) |
| `loadNetlistJson` | 942 | Entry point: strategy choice and orchestration |
| `snap`, `GRID_SIZE` | `utils/geometry.ts` | Rounding, and pixels per grid unit on screen |

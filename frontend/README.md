# NETSCOPE — Schematic Capture (frontend)

A browser-based schematic editor, in the spirit of LTspice: drag components
onto a grid, wire them together, and send the circuit off to a simulator.
This step builds the **frontend only** (TypeScript + React). The Python
simulation backend is a separate, later step — the app already sends a
well-defined JSON request for it and handles the "backend not running yet"
case gracefully.

## Requirements

- Node.js 18+ and npm

## Run it

```bash
cd circuit-sim
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

```bash
npm run build      # production build, output in dist/
npm run preview    # serve that production build locally
```

## Using the editor

- **Add a part**: drag a symbol from the left rail onto the canvas, or
  click a symbol to drop it at the canvas origin.
- **Move a part**: click and drag its body.
- **Wire two parts**: click (or press and drag) one pin, then click the
  pin you want to connect it to. Click empty space or press `Esc` to
  cancel a wire in progress.
- **Select**: click a part or a wire. The right panel shows its details.
- **Rotate / Mirror**: `R` / `M`, or the buttons in the right panel.
- **Delete**: `Delete`/`Backspace`, or the Delete button.
- **Edit a value**: click a part, type into its field — SI suffixes work,
  e.g. `4.7k` for 4700, `10u` for 1e-5, `1e-6` also works directly.
- **Pan**: right-click-drag (or middle-click-drag) the canvas.
- **Zoom**: mouse wheel.
- Every circuit needs a **Ground** part placed somewhere — it's the 0V
  reference node the backend's simulator will solve against.

## Sending a simulation request

The **Simulate** button (bottom-right panel) builds a JSON payload from
the current schematic and `POST`s it to the backend. "Show request JSON"
lets you inspect exactly what will be sent before the backend exists.

Payload shape:

```json
{
  "netlist": {
    "version": 1,
    "components": [
      { "id": "...", "ref": "R1", "type": "resistor", "nodes": ["1", "0"], "params": { "resistance": 1000 } },
      { "id": "...", "ref": "V1", "type": "vsource_dc", "nodes": ["1", "0"], "params": { "voltage": 5 } }
    ],
    "nets": ["0", "1"]
  },
  "analysis": {
    "mode": "tran",
    "tran": { "stepSeconds": 0.000001, "stopSeconds": 0.001 },
    "ac": { "startHz": 1, "stopHz": 1000000, "pointsPerDecade": 20 }
  }
}
```

Notes on the netlist:
- `nodes` lists the net name for each pin of a component, **in the same
  order as that component's pin definitions** (see `domain/componentDefs.ts`).
- Net `"0"` is always ground, by SPICE convention. Any pin wired to a
  Ground part collapses onto net `"0"`.
- Two pins are on the same net if they're connected by a wire, directly
  or through other components/wires — this is computed with a
  union-find over all wires (`domain/netlist.ts`).

Point the request at your backend by creating a `.env` file (see
`.env.example`) with:

```
VITE_SIMULATE_URL=http://localhost:8000/simulate
```

Until that backend exists, clicking Simulate will fail with a clear
"couldn't reach the backend" message rather than crashing the app — this
is expected for now. The expected response shape (`api/simulate.ts`) is:

```json
{ "ok": true, "message": "optional status text", "traces": { "time": [...], "V(1)": [...] } }
```

## Project structure

```
src/
  types/circuit.ts          Core domain types (components, pins, wires)
  domain/
    componentDefs.ts        Registry of component kinds — pins, params, symbol id
    netlist.ts               Builds the JSON netlist (union-find over wires)
    simulationConfig.ts     Analysis (DC/transient/AC) settings + defaults
  api/simulate.ts            POSTs to the backend, typed request/response
  store/circuitStore.ts      Zustand store — the single source of truth
  utils/
    geometry.ts               Grid math, rotation/mirroring, pin resolution
    units.ts                   SI-prefix parsing/formatting ("4.7k" <-> 4700)
  canvas/
    symbols.tsx                SVG schematic symbol drawings, one per part kind
    ComponentView.tsx          Renders one placed part + its pins
    WireView.tsx                Renders one wire as an orthogonal trace
    useCanvasView.ts           Pan/zoom state + screen<->grid conversion
    SchematicCanvas.tsx        The canvas: placement, dragging, wiring, pan/zoom
  components/
    Toolbar.tsx                 Title bar
    ComponentPalette.tsx        Left rail of draggable parts
    PropertiesPanel.tsx         Right panel: selected part's parameters
    SimulationPanel.tsx         Right panel: analysis settings + Simulate button
  App.tsx                       Shell layout wiring the pieces together
```

## Adding a new component kind later

Everything about a component's electrical shape and appearance is
data-driven from two places, so adding e.g. a diode doesn't touch the
canvas, store, or netlist logic:

1. Add the kind to `ComponentKind` in `types/circuit.ts`.
2. Add an entry to `COMPONENT_DEFS` in `domain/componentDefs.ts` (pins,
   parameters, footprint, ref prefix) and to `PALETTE_ORDER`.
3. Draw its symbol in `canvas/symbols.tsx` and register it in `SYMBOLS`
   under the same `symbolId`.

That's it — placement, dragging, rotation/mirroring, wiring, the
properties panel, and the netlist builder all work generically off the
`ComponentDef`.

## Design notes

- All schematic geometry is stored in **grid units**, not pixels
  (`GRID_SIZE` in `utils/geometry.ts` is the only place that maps one to
  the other) — this keeps snapping, rotation, and pin math simple.
- Wires connect two pins by reference (`PinRef`), not by coordinates, so
  moving a part automatically drags its wires with it. Routing between
  two pins is auto-computed (`orthogonalPath`) each render.
- View state (pan/zoom) is intentionally kept out of the Zustand store —
  it's per-session UI state, not part of the document you'd save or send
  to the backend.

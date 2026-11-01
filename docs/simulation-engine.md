# Simulation Engine: How Voltages and Currents Are Calculated

This doc covers what happens when you press **▶ Run Simulation**: how the drawn schematic becomes a circuit that can be solved, how ngspice solves it, and how the results become the numbers, arrows and animations on parts and wires. It also covers **wires** in detail: what voltage a wire shows, why the voltage difference along a wire is always 0 V, and how the current in each wire is worked out.

Companion doc: [component-placement.md](component-placement.md) explains how a loaded netlist is laid out on the canvas.

---

## Contents

1. [Big picture](#1-big-picture)
2. [Step 1 — Schematic → netlist (frontend)](#2-step-1--schematic--netlist-frontend)
3. [Step 2 — Netlist → SPICE deck (backend)](#3-step-2--netlist--spice-deck-backend)
4. [Step 3 — Solving with ngspice](#4-step-3--solving-with-ngspice)
5. [Step 4 — Per-component branch analysis](#5-step-4--per-component-branch-analysis)
6. [Sign conventions (read this before trusting an arrow)](#6-sign-conventions)
7. [Wires: voltage, voltage difference and current](#7-wires-voltage-voltage-difference-and-current)
8. [What the canvas draws](#8-what-the-canvas-draws)
9. [DC vs AC analysis](#9-dc-vs-ac-analysis)
10. [Worked example](#10-worked-example)
11. [Thresholds and constants](#11-thresholds-and-constants)
12. [Known limitations](#12-known-limitations)
13. [Testing the conventions](#13-testing-the-conventions)
14. [Code reference](#14-code-reference)

---

## 1. Big picture

The app does **not** solve circuit equations itself. It turns the drawing into a standard SPICE netlist and lets **ngspice** (an open-source circuit simulator) solve it. It then reads ngspice's answers back and adapts them for display.

```
 ┌──────────────── Frontend (React) ───────────────┐        ┌──────────── Backend (FastAPI) ────────────┐
 │                                                 │        │                                           │
 │ components + wires                              │        │ _build_spice_deck()                       │
 │      │  buildNetlist()  (union-find → nets)     │  POST  │      │  adds 0 V "sense" sources          │
 │      ▼                                          │ ─────► │      ▼                                    │
 │ Netlist JSON { components[], nets[] } ──────────┼────────┤ ngspice -b deck.cir  (op  or  ac lin 1 f) │
 │                                                 │/simulate      │                                    │
 │                                                 │        │      ▼  _parse_results()                  │
 │ SimulationResult ◄──────────────────────────────┼────────┤ _compute_branch_analysis()                │
 │      │                                          │        │      → voltage_a/b, delta_v, current_a,   │
 │      ├─ BranchAnalysisPanel (table)             │        │        direction  per component           │
 │      ├─ ComponentView badges (ΔV, I per part)   │        └───────────────────────────────────────────┘
 │      ├─ AnalysisOverlay (node-voltage pills)    │
 │      └─ computeWireCurrents() → WireView        │
 │           (current per wire, by KCL)            │
 └─────────────────────────────────────────────────┘
```

Who does what:

| Quantity | Computed by | Where |
|---|---|---|
| Which pins are electrically the same point (nets) | Frontend, union-find over wires | `domain/netlist.ts` → `buildNetlist` |
| Node voltages `V(n)` | ngspice (Modified Nodal Analysis) | backend `main.py` |
| Current through each part | ngspice, read from a 0 V series "sense" source | backend `main.py` → `_build_spice_deck` |
| ΔV across each part, direction, zero-snapping | Backend post-processing | `main.py` → `_compute_branch_analysis` |
| Current in each **wire** | Frontend, Kirchhoff's current law on the wire graph | `domain/currentFlow.ts` → `computeWireCurrents` |
| Voltage shown on a wire | Frontend, the voltage of the net the wire belongs to | `canvas/SchematicCanvas.tsx` → `wireAnalysis` |

---

## 2. Step 1 — Schematic → netlist (frontend)

`runSimulate()` in `store/circuitStore.ts` calls `buildNetlist(components, wires)` and posts the result with the analysis config to `/simulate` (`api/simulate.ts`).

### 2.1 Pins, wires and nets

- Every component has pins defined in `domain/componentDefs.ts`. Two-terminal parts list their pins in a fixed order, and **that order matters**: pin index 0 is "pin a" and pin index 1 is "pin b" in everything that follows.

  | Kind | Pin a (index 0) | Pin b (index 1) |
  |---|---|---|
  | `resistor`, `capacitor`, `inductor` | p1 | p2 |
  | `vsource_dc`, `vsource_ac`, `battery` | `+` | `−` |
  | `vsource_dep` | A | B |
  | `diode` | anode | cathode |
  | `ground` | GND (single pin) | — |

  Three-pin parts follow the same rule, with a third pin after the pair:

  | Kind | Pin a (index 0) | Pin b (index 1) | Pin 2 | So ΔV / current mean |
  |---|---|---|---|---|
  | `bjt_npn`, `bjt_pnp` | C (collector) | E (emitter) | B (base) | Vce / Ic (into the collector) |
  | `opamp` | `+` (non-inverting) | `−` (inverting) | out | V(+) − V(−) / current into `+` (≈ 0) |

  Their pins carry an explicit `dir` (outward direction), so on an upright transistor the collector and emitter wires leave vertically rather than at 45°.

- A **wire** connects exactly two pins (`Wire.from`, `Wire.to` in `types/circuit.ts`). It has no electrical properties of its own: no resistance, no length, no value.

- A **net** (or node) is a set of pins that are connected by wires, directly or through a chain of wires. Every pin in a net has the same voltage.

### 2.2 Union-find

`buildNetlist` builds the nets with a **union-find** (disjoint-set) structure keyed by `"componentId:pinId"`:

1. **Seed** every pin of every component as its own set, so an unconnected pin still gets a net of its own.
2. **Union** the two pins of every wire.
3. Each resulting set is one net.

This is why wire topology (junctions, T-joints, chains of wires) does not matter for the solver: however the wires are drawn, connected pins end up in the same net.

### 2.3 Naming nets and choosing ground

- Any set that contains a `ground` component's pin is named **`"0"`**, SPICE's reference node (0 V).
- **No ground drawn?** A circuit without a reference cannot be solved, so a hidden reference is chosen: the **last pin** (the `−` terminal) of the first voltage source becomes `"0"`. If there is no source, the last pin of the first device is used.
- Every other net gets a number `"1"`, `"2"`, … in the order it is first seen.
- `ground` components are **not** sent as devices. They only mark a net as `"0"`.

### 2.4 Output

```json
{
  "version": 1,
  "components": [
    { "id": "…", "ref": "V1", "type": "vsource_dc", "nodes": ["1", "0"], "params": { "voltage": 10 } },
    { "id": "…", "ref": "R1", "type": "resistor",   "nodes": ["1", "2"], "params": { "resistance": 1000 } },
    { "id": "…", "ref": "R2", "type": "resistor",   "nodes": ["2", "0"], "params": { "resistance": 4000 } }
  ],
  "nets": ["0", "1", "2"]
}
```

`nodes[i]` is the net of pin `i`, so `nodes[0]` is always pin a and `nodes[1]` is pin b.

---

## 3. Step 2 — Netlist → SPICE deck (backend)

`_build_spice_deck()` in `backend/main.py` writes a text deck that ngspice understands.

### 3.1 Ground

Any net touching a `ground` component is mapped to `"0"`. The frontend has already done this, but the backend repeats it so netlists from other sources (for example the image pipeline) still work.

### 3.2 Element names

Each element gets a unique, index-based name: `<prefix><index>_<ref>`, e.g. `V0_V1`, `R1_R1`, `R2_R2`. The index stops clashes when two parts share a ref (the DC and AC source palettes both start at `V1`).

| `type` | SPICE prefix | SPICE line |
|---|---|---|
| `resistor` | `R` | `R… a s<i> <resistance>` (default 1 kΩ; 0 Ω is replaced by 1 kΩ) |
| `capacitor` | `C` | `C… a s<i> <capacitance>` (default 1 µF) |
| `inductor` | `L` | `L… a s<i> <inductance>` (default 1 mH) |
| `diode` | `D` | `D… a s<i> DMOD` with `.model DMOD D(IS=2.52n RS=0.568 N=1.752)` (a 1N4148-like model) |
| `vsource_dc`, `battery`, `vsource_dep` | `V` | `V… a b DC <voltage>` |
| `vsource_ac` | `V` | `V… a b DC 0 AC <amplitude> SIN(0 <amplitude> <frequency>)` |
| `bjt_npn`, `bjt_pnp` | `Q` | `Q… c b e QM<i>` with `.model QM<i> NPN\|PNP(IS=1e-14 BF=<beta> BR=1 VAF=100)`: a generic small-signal transistor (2N3904/2N3906 class), one model per part so each can have its own β (default 100) |
| `opamp` | `B` | `R<i>_in + − 10Meg` and `B… out 0 V=Vmid+Vhalf*tanh(gain*(v(+)-v(−))/Vhalf)` (see §3.4) |
| `ground` | — | not emitted |

### 3.3 Sense sources: how part currents are measured

SPICE only reports currents through **voltage sources** (as `<name>#branch`). To get the current through a resistor, capacitor, inductor or diode, every passive part gets a **0 V voltage source in series**:

```
R1_R1  1  s1  1000      ← the resistor now ends at an internal node s1
VS1    s1 2   0         ← 0 V source from s1 to the real pin-b net
```

A 0 V source changes nothing electrically (it is a short), but ngspice now reports `vs1#branch`: the current flowing **from s1 to node 2 through VS1**. That is the current through R1 from pin a to pin b. Positive means a → b.

Voltage sources need no sense source: ngspice already reports `v0_v1#branch`, the current through the source from its `+` node to its `−` node.

`deck.branch` remembers, for each component index, which `#branch` vector holds its current.

**Three-pin parts** get a sense source on **every** pin, from the outer net to an internal node (`VS<i>_<k>  net  s<i>_<k>  0`). Each `vs<i>_<k>#branch` is the current flowing **into the part at pin k**. They are kept in `deck.pins`; `deck.branch` points at pin 0's, so `current_a` is the current into pin a (Ic for a transistor).

### 3.4 The op-amp model

An ideal op-amp with output limits, as one behavioural voltage source on the output:

```
Vout = Vmid + Vhalf · tanh( gain · (V(+) − V(−)) / Vhalf )
Vmid = (vpos + vneg) / 2,  Vhalf = (vpos − vneg) / 2
```

- Near zero input it is linear with slope `gain` (open-loop gain, default 10⁵), so negative-feedback circuits settle at the textbook values (e.g. inverting gain −Rf/Rin, with the tiny finite-gain error).
- With no feedback it saturates smoothly at the rails `vpos` / `vneg` (default ±15 V) instead of reaching 10⁵ × Vin. Single-supply rails (e.g. 0 and 5 V) work too.
- Input resistance 10 MΩ between the inputs, zero output resistance.
- The output is referenced to ground and its current comes from the **supply, which is not drawn**. So an op-amp's pin currents don't sum to zero: the difference returns through the ground net.
- In AC mode ngspice linearises it at the DC operating point, so the AC gain is the closed-loop gain.

### 3.5 Control block

```
.control
set numdgt=12            ← 12 significant digits, so KCL and power balance add up exactly
op                       ← DC operating point        (or: ac lin 1 f f  for AC, see §9)
echo RESULTS_BEGIN
print v(1) v(2) v0_v1#branch vs1#branch vs2#branch
echo RESULTS_END
.endc
.end
```

The internal sense nodes `s<i>` are not printed; only real nets and branch currents are.

---

## 4. Step 3 — Solving with ngspice

`_run_ngspice()` writes the deck to a temp `.cir` file and runs `ngspice -b` (batch mode) with a 30 s timeout. The binary is found by `_find_ngspice()`: `NGSPICE_PATH` env var first, then `ngspice_con` (Windows/Chocolatey), then `ngspice`.

### 4.1 What ngspice actually computes

ngspice uses **Modified Nodal Analysis (MNA)**. For a DC operating point it builds one equation per unknown and solves the linear system `G·x = b`:

- **Unknowns:** the voltage of every non-ground node, plus the current through every voltage source (including the 0 V sense sources).
- **One KCL equation per node:** the currents leaving the node through all attached elements sum to zero. A resistor between nodes i and j contributes `(Vi − Vj)/R`.
- **One equation per voltage source:** `V(+) − V(−) = E`.

At DC, a capacitor is an open circuit and an inductor is a short. Diodes are nonlinear, so ngspice repeats the solve (Newton–Raphson) until the result stops changing.

For AC (§9) the same system is built with complex impedances (`1/(jωC)`, `jωL`) and solved once at one frequency. The result is a **phasor** (a complex number) for each node and branch.

### 4.2 Reading the output

`_parse_results()` takes the text between `RESULTS_BEGIN` and `RESULTS_END` and matches every `name = value` line. It returns a dict such as:

```python
{ "v(1)": 10+0j, "v(2)": 8+0j, "v0_v1#branch": -0.002+0j, "vs1#branch": 0.002+0j, "vs2#branch": 0.002+0j }
```

DC values are stored as complex numbers with a zero imaginary part, so DC and AC share the same code afterwards. If **any** expected vector is missing (a singular circuit, a floating node, two ideal sources in parallel, …) the function returns `None`. `/simulate` then responds with `ok: false` and the ngspice error lines.

---

## 5. Step 4 — Per-component branch analysis

`_compute_branch_analysis()` turns the raw vectors into one `BranchInfo` record per part:

```ts
interface BranchInfo {
  component_id: string;
  ref: string;            // "R1"
  type: string;           // "resistor"
  node_a: string;         // net of pin a
  node_b: string;         // net of pin b
  voltage_a: number;      // V(node_a), volts vs ground
  voltage_b: number;      // V(node_b)
  delta_v: number;        // V(node_a) − V(node_b)
  current_a: number;      // current THROUGH the part, + = pin a → pin b
  direction: "a_to_b" | "b_to_a" | "none";
  // every pin, in pin order:
  pin_nodes: string[];    // its net
  pin_voltages: number[]; // its voltage (same rules as voltage_a)
  pin_currents: number[]; // current INTO the part at that pin
}
```

For two-pin parts `pin_currents` is `[current_a, −current_a]`. For transistors and op-amps the pin currents are read from the per-pin sense sources (§3.3) and are what the canvas uses: a transistor's three currents differ (Ie = −(Ic + Ib)), and an op-amp's output current comes from its undrawn supply. For those parts `current_a` is the current into pin a (Ic, or the op-amp's `+` input current).

How each field is computed:

| Field | Formula | Notes |
|---|---|---|
| `voltage_a`, `voltage_b` | `V(node)`; `0` if the node is `"0"` | DC: the signed real value. AC: the **magnitude** `|V|`. Values below 1 mV are snapped to `0`. Rounded to 6 decimals. |
| `delta_v` | `signed(V(a) − V(b))` | The difference is taken on the full phasors **before** they are turned into a single number, so in AC it is the correct amplitude of the voltage across the part. Below 1 mV → `0`. |
| `current_a` | `signed(<branch>#branch)` | Read from the sense source (passive parts) or the source's own branch (voltage sources). Below 1 nA → `0`. Rounded to 12 decimals. |
| `direction` | `a_to_b` if `current_a > 0`, `b_to_a` if `< 0`, `none` if snapped to 0 | |
| `pin_currents` | `signed(vs<i>_<k>#branch)` per pin (three-pin parts) | Below 1 nA → `0`. |

### 5.1 `_signed()`: one number from a phasor

A phasor has a magnitude and a phase, but the UI shows one signed number. `_signed(z)` returns `|z|` with a sign:

- the sign of the **real part** (the part in phase with the source), or
- the sign of the **imaginary part** when the real part is negligible (`< 1e-6·|z|`, i.e. a purely reactive quantity such as the current in an ideal capacitor).

For DC, `z` is real, so `_signed(z)` is just `z`.

### 5.2 Traces

`/simulate` also returns `traces`, a flat map such as `{"V(1)": [10], "I(R1)": [0.002]}`, with one value per vector; three-pin parts give one current per pin, e.g. `I(Q1.C)`, `I(Q1.E)`, `I(Q1.B)`, `I(U1.OUT)`. These come from the same numbers and are mainly a summary. The canvas uses `branch_analysis`.

---

## 6. Sign conventions

Every part, sources included, uses the **passive sign convention**:

> `delta_v = V(pin a) − V(pin b)`, and `current_a` is the current flowing **through** the part from pin a to pin b.

What that means in practice:

| Part | Typical result | Reading |
|---|---|---|
| Resistor | `delta_v > 0`, `current_a > 0` | Current flows from the higher potential to the lower, a → b. A resistor always has `delta_v` and `current_a` with the same sign: it absorbs power (`P = ΔV·I > 0`). |
| Source delivering power | `delta_v > 0`, `current_a < 0` (`direction: b_to_a`) | Inside the source current climbs from `−` (b) to `+` (a). Outside it leaves `+`, runs through the circuit and returns to `−`. `P = ΔV·I < 0` means the source is **supplying** power. |
| Source being charged (e.g. two batteries fighting) | `current_a > 0` | Current is forced into `+`: the source absorbs power. |
| Part with no current (e.g. capacitor at DC) | `current_a = 0`, `direction: none` | |

**Power check.** With this convention `Σ delta_v · current_a = 0` over all parts (Tellegen's theorem). It is a quick sanity check on any result.

The UI shows **magnitudes** for current and uses arrows for direction, so a negative `current_a` is never shown as "−2 mA". It is shown as "2 mA" with the arrow pointing b → a.

---

## 7. Wires: voltage, voltage difference and current

### 7.1 A wire is ideal

A wire in this app is an **ideal conductor**: zero resistance, zero inductance, zero capacitance. In §2.2 both ends of a wire are merged into the **same net**, and ngspice never sees wires at all. It only sees nets.

Consequences:

| Quantity | Value | Why |
|---|---|---|
| Voltage at the wire's `from` end | `V(net)` | |
| Voltage at the wire's `to` end | `V(net)`, the **same** net | Union-find merged them |
| **Voltage difference along a wire** | **Exactly 0 V, always** | Ohm's law with `R = 0`: `ΔV = I·0 = 0`, whatever the current |
| Current in a wire | Can be anything | Decided by Kirchhoff's current law (KCL), not by Ohm's law (§7.3) |

So all of the voltage drop in a circuit happens **across components**, never along wires. This is the standard ideal-schematic model used in textbooks and SPICE.

### 7.2 The voltage shown on a wire

`wireAnalysis` in `canvas/SchematicCanvas.tsx`:

```ts
const va = nodeVoltageMap.get(fromNet);
const vb = nodeVoltageMap.get(toNet);
const avgV = va !== undefined && vb !== undefined ? (va + vb) / 2 : va ?? vb;
```

`nodeVoltageMap` is built from `branch_analysis` (`node_a → voltage_a`, `node_b → voltage_b`). Because `fromNet === toNet` for every wire, `va === vb`, and the "average" is just **the voltage of the wire's net**. The averaging is only a safeguard: if one end is missing from the map, the other end's value is used.

This value appears on the wire's pill when **Wire labels** is set to *Voltage* or *Both*.

### 7.3 The current in a wire (KCL on the wire graph)

ngspice gives the current through each **component**, but not through each **wire**. If three wires meet at a junction, how much current does each carry? `computeWireCurrents()` in `domain/currentFlow.ts` works it out with KCL.

**Step 1: what each pin pushes into its wires.** `currentOutOfPin(component, pin, branch)`:

| Pin | Current leaving the part into the wire |
|---|---|
| Pin a (index 0) | `−current_a` (through-current a → b *enters* at a) |
| Pin b (index 1) | `+current_a` (and *leaves* at b) |
| Any pin, when `pin_currents` is present | `−pin_currents[i]` (used first; needed for transistors and op-amps) |

Example: a resistor with `current_a = +2 mA` *takes* 2 mA from the wire at pin a (injection −2 mA) and *pushes* 2 mA into the wire at pin b (+2 mA). A source with `current_a = −2 mA` pushes +2 mA out of its `+` pin, as expected.

**Step 2: a graph per net.** The pins are the vertices and the wires are the edges. Each connected group is one net's wiring.

**Step 3: spanning tree.** A breadth-first search from any pin builds a spanning tree and records each pin's parent wire.

**Step 4: balance unknown pins.** A pin whose part has no `BranchInfo` (normally a **ground symbol**, which is not a device) is "unknown". KCL says the injections in a node sum to zero:

- One unknown pin: its injection is set to `−(sum of the known ones)`. This is how the return current shows up on the wire into a ground symbol.
- More than one unknown pin: the split is not determined, so the wires in that net are left without a current.

**Step 5: leaves first.** Walking the BFS order backwards (leaves first), the current a pin's subtree pushes up its parent wire is:

```
total(p) = injection(p) + Σ total(children of p)
```

That `total` flows from `p` toward its parent along the parent wire. It is then expressed relative to the wire's own `from → to` direction:

```ts
const along = pinKey(up.wire.from) === p ? total : -total;   // + = from → to
direction = along > 0 ? "a_to_b" : along < 0 ? "b_to_a" : "none";
```

Here `a_to_b` means **from the wire's `from` pin to its `to` pin**, not a component's pin a and pin b.

**Step 6: loops.** A wire that is not in the spanning tree closes a loop **made only of wire** inside one net (for example two parallel wires between the same two pins). With zero resistance the split around such a loop is undetermined, so these wires are reported as carrying `0 A`.

#### Why this is right

In a tree there is only one path between any two pins. Cutting a tree wire splits the net into two sides, and KCL forces the wire to carry exactly the net injection of one side. This handles every kind of junction: T-joints, star points, long chains of pin-to-pin wires, and bridges.

#### Example: a T-junction

```
   V1(+) ──w1── R1(a)       V1 pushes +3 mA   (inj +3 mA)
                  │          R1 draws 1 mA    (inj −1 mA)
                  w3         R2 draws 2 mA    (inj −2 mA)
                  │
                R2(a)
```

There is no separate junction object. Wires always join two pins, so the junction is R1(a), the pin both wires share (w1 = V1(+)→R1(a), w3 = R1(a)→R2(a)). The tree walk gives 3 mA on the wire leaving V1, and 2 mA on the wire to R2. R1(a) keeps the 1 mA it draws. That is KCL at the junction: 3 = 1 + 2.

---

## 8. What the canvas draws

All overlays appear only when `simStatus === "done"` and `branch_analysis` exists (`analysisActive`).

| Visual | Source | Rule |
|---|---|---|
| **Node-voltage pills** at pins (`AnalysisOverlay`) | `buildNodeLabels` | One pill per (net, position). Voltage of the pin's net. Ground nets and `|V| < 1 mV` show `0.00 V`. |
| **Component badge** (ΔV, I) (`ComponentView`) | `branch_analysis[i].delta_v`, `current_a` | Shown for parts toggled from the Branch Analysis table, or for all parts. |
| **Branch Analysis table** (`BranchAnalysisPanel`) | `branch_analysis` | ΔV (signed), `|current_a|`, and direction as `node_from → node_to`. |
| **Current dashes and arrow** on a wire (`WireView`) | `computeWireCurrents` | Arrow at the middle of the longest segment, pointing in the current's direction. Dashes animate faster for larger currents (≥1 A: 0.25 s, ≥10 mA: 0.4 s, ≥1 mA: 0.7 s, else 1.2 s). Hidden for `|I| ≤ 1e-15 A`. Toggle: *Current direction*. |
| **Voltage arrows and dots** near each wire end | `pinPolarity()` | For the part at each end: if the wire meets that part's **higher-potential pin** (its `+` end by ΔV) the arrow points **into** the part (voltage drops into it). If it meets the lower pin, the arrow points **out**. If the two ends disagree, each half of the wire animates toward its own part. Parts with `|ΔV| < 1 mV` get no arrow. Toggle: *Voltage direction*. |
| **Wire value pills** | `wireAnalysis` | Current `|I|` and/or the net voltage (§7.2), per the *Wire labels* setting. A selected wire always shows its current. |

Note that the **voltage arrows on a wire describe the components at its ends**, not a voltage drop along the wire. The drop along the wire is still 0 V (§7.1).

---

## 9. DC vs AC analysis

`/simulate` decides the analysis like this:

```
if the netlist has a vsource_ac  AND  analysis.mode != "dc":
    AC steady state at the FIRST AC source's frequency   (ac lin 1 f f)
else:
    DC operating point                                    (op)
```

| | DC (`op`) | AC (`ac lin 1 f f`) |
|---|---|---|
| Capacitor | open circuit | impedance `1/(jωC)` |
| Inductor | short circuit | impedance `jωL` |
| DC sources | their voltage | **0** (AC value 0, so they drop out). The response message says *"DC sources are not included"*. |
| AC sources | 0 V (`DC 0`) | amplitude at their phase |
| Reported numbers | exact signed values | **peak amplitudes** |
| `voltage_a/b` | signed | `|V|`, always ≥ 0 |
| `delta_v`, `current_a` sign | real sign | sign relative to the source's phase (§5.1) |

If several AC sources have different frequencies, they are all solved at the first one's frequency, and the message says so.

> In AC, `delta_v` is generally **not** `voltage_a − voltage_b`. The node voltages are shown as magnitudes, but ΔV is computed from the full phasors. For example, the voltage across a capacitor in an RC circuit is not the difference of the two node amplitudes.

---

## 10. Worked example

Circuit: a 10 V DC source, R1 = 1 kΩ and R2 = 4 kΩ in series, and a ground symbol on the source's `−`.

```
     ┌──w1── R1 ──w2──┐
   V1 +               R2
   10V −              │
     └──w4── GND ─w3──┘
```

**Netlist (frontend):** the ground pin's set → `"0"`, V1+ / R1a → `"1"`, R1b / R2a → `"2"`.

```
V1 [1, 0]   R1 [1, 2]   R2 [2, 0]
```

**Deck (backend):**

```
* Auto-generated by circuit-backend
V0_V1 1 0 DC 10
R1_R1 1 s1 1000
VS1 s1 2 0
R2_R2 2 s2 4000
VS2 s2 0 0
.control
set numdgt=12
op
echo RESULTS_BEGIN
print v(1) v(2) v0_v1#branch vs1#branch vs2#branch
echo RESULTS_END
.endc
.end
```

**ngspice (MNA):** `I = 10 / (1000 + 4000) = 2 mA`, `V(1) = 10 V`, `V(2) = 10 − 2 mA·1 kΩ = 8 V`.

```
v(1) = 10    v(2) = 8    v0_v1#branch = -0.002    vs1#branch = 0.002    vs2#branch = 0.002
```

**branch_analysis:**

| ref | node_a → node_b | voltage_a | voltage_b | delta_v | current_a | direction |
|---|---|---|---|---|---|---|
| V1 | 1 → 0 | 10 | 0 | +10 | −0.002 | b_to_a (supplying power) |
| R1 | 1 → 2 | 10 | 8 | +2 | +0.002 | a_to_b |
| R2 | 2 → 0 | 8 | 0 | +8 | +0.002 | a_to_b |

Power check: `10·(−0.002) + 2·0.002 + 8·0.002 = −0.02 + 0.004 + 0.016 = 0` ✓

**Wires:**

| Wire | Net | Voltage shown | ΔV along wire | Current (by §7.3) |
|---|---|---|---|---|
| w1 (V1+ → R1a) | 1 | 10.00 V | 0 V | 2 mA, V1 → R1 |
| w2 (R1b → R2a) | 2 | 8.00 V | 0 V | 2 mA, R1 → R2 |
| w3 (R2b → GND) | 0 | 0.00 V | 0 V | 2 mA, R2 → GND (the ground pin's injection is balanced as unknown: −2 mA) |
| w4 (GND → V1−) | 0 | 0.00 V | 0 V | 2 mA, GND → V1− |

The full 10 V is dropped across R1 (2 V) and R2 (8 V). None of it is dropped along a wire.

---

## 11. Thresholds and constants

| Constant | Value | Where | Effect |
|---|---|---|---|
| `_ZERO_SNAP` | 1 mV | `main.py` | `|V|` or `|ΔV|` below this is reported as 0 |
| `_CURRENT_SNAP` | 1 nA | `main.py` | `|I|` below this → 0, `direction: none`. Hides ngspice's GMIN leakage (~1e-12 S per node), e.g. pA "currents" behind a capacitor at DC. |
| `numdgt` | 12 | SPICE deck | Printed precision |
| ngspice timeout | 30 s | `_run_ngspice` | Then HTTP 500 |
| Wire "no current" | `< 1e-15 A` | `currentFlow.ts`, `WireView.tsx` | No arrow or dashes |
| Voltage-arrow threshold | `|ΔV| < 1 mV` | `pinPolarity` | No voltage arrow for that part |
| Display "0 V" | `< 1 mV` | formatters | Shown as `0 V` / `0.00 V` |
| Default values | R 1 kΩ, C 1 µF, L 1 mH, V 5 V, AC f 50 Hz | `_build_spice_deck` | Used when a param is missing |

---

## 12. Known limitations

- **Transient analysis is not run.** The UI has a *Transient* mode and step/stop settings (`domain/simulationConfig.ts`, default mode `"tran"`), but the backend only ever does a DC operating point or a single-frequency AC solve. `tran` and the `ac` sweep settings are accepted and ignored.
- **Wires are ideal.** There is no wire resistance, so the voltage drop along a wire is always 0 V and a wire cannot be used to model a real cable. To model one, place a small resistor.
- **Wire-only loops** (two wires in parallel between the same pins) are reported as 0 A on the loop-closing wire, because the split is undetermined.
- **More than one unknown pin per net** (e.g. two ground symbols wired into the same net through wires) leaves that net's wire currents unset.
- **Dependent sources** (`vsource_dep`) are simulated as a plain independent DC source at their `voltage` parameter. The controlling expression is not captured.
- **Mixed DC + AC sources:** in AC mode the DC sources are dropped (no superposition of the DC bias with the AC response).
- **AC node voltages are magnitudes**, so their sign and phase are lost on the node pills (§9).
- **Floating or singular circuits** (a node with no DC path to ground, a loop of ideal voltage sources) make ngspice fail, and the user sees `ok: false` with ngspice's error lines.
- **Transistors** are a generic BJT model (only β is editable); there are no MOSFETs.
- **Op-amps** are ideal apart from gain and output limits: no supply pins, no bandwidth/slew rate, no input offset or bias current. Their output current returns through the ground net, so in a circuit with no ground symbol the wire currents of that net can't balance exactly.
- **Image import** places transistors and op-amps only with a model that detects them (`circuit_yolo11_v4_best.pt`). Which leg is the emitter, NPN vs PNP, and which op-amp input is `+` are worked out from the wiring and the drawing (see `backend/BACKEND_SUMMARY.md` §4, stages 7d–7e) and can be wrong on small or unusual symbols; the part can be swapped in the editor. The CircuitJS export still leaves them out.

---

## 13. Testing the conventions

Two scripts check the sign conventions end to end:

- **`backend/check_solver_polarity.py`**: checks the backend's `branch_analysis` signs and directions on reference circuits.
- **`backend/check_active_parts.py`**: transistors and op-amps against circuit theory (bias point, β, KCL inside the part and at every net, inverting / non-inverting gain, rail saturation, AC gain). Runs in-process, no server needed: `cd backend && python check_active_parts.py`.
- **`frontend/scripts/check-current-direction.mjs`**: builds circuits the way the editor does (`buildNetlist`), calls the running backend, and passes the results through `computeWireCurrents` / `currentOutOfPin`. The expected result everywhere: conventional current leaves a source's `+`, runs high → low through each part, and returns to `−`.

```bash
# terminal 1
cd backend && uvicorn main:app --port 8000
# terminal 2
cd frontend && node scripts/check-current-direction.mjs
```

The backend also prints the deck, the raw ngspice output and a branch-analysis table to its console on every `/simulate` call. That is the fastest way to debug a surprising number.

---

## 14. Code reference

| File | Symbol | Role |
|---|---|---|
| `frontend/src/store/circuitStore.ts` | `runSimulate` | Builds the netlist, calls the API, stores `simResult` |
| `frontend/src/domain/netlist.ts` | `buildNetlist` | Union-find pins → nets, ground / hidden reference |
| `frontend/src/domain/componentDefs.ts` | `COMPONENT_DEFS`, `getDef` | Pin order (pin a / pin b) for every kind |
| `frontend/src/api/simulate.ts` | `runSimulation`, `BranchInfo` | POST `/simulate`, response types |
| `backend/main.py` | `_build_spice_deck` | Netlist → SPICE deck, sense sources |
| `backend/main.py` | `_add_multi_pin`, `_MULTI_PIN` | Transistor / op-amp lines, per-pin sense sources |
| `backend/main.py` | `_run_ngspice`, `_find_ngspice` | Runs ngspice in batch mode |
| `backend/main.py` | `_parse_results` | ngspice text → `{vector: complex}` |
| `backend/main.py` | `_signed` | Phasor → signed scalar |
| `backend/main.py` | `_compute_branch_analysis` | Per-part V, ΔV, I, direction |
| `backend/main.py` | `simulate` | `/simulate` route, DC vs AC choice |
| `frontend/src/domain/currentFlow.ts` | `currentOutOfPin`, `computeWireCurrents` | Wire currents by KCL |
| `frontend/src/canvas/SchematicCanvas.tsx` | `pinNetMap`, `nodeVoltageMap`, `wireAnalysis`, `pinPolarity`, `nodeLabels` | Joins results to pins and wires |
| `frontend/src/canvas/WireView.tsx` | `WireView` | Current and voltage arrows, dashes, labels on a wire |
| `frontend/src/canvas/AnalysisOverlay.tsx` | `AnalysisOverlay`, `buildNodeLabels` | Node-voltage pills |
| `frontend/src/components/BranchAnalysisPanel.tsx` | `BranchAnalysisPanel` | Per-component results table |

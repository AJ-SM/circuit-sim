// Checks the wire current-direction convention end to end: builds circuits the
// way the editor does, simulates them on the running backend, and runs the
// results through the same code the canvas uses (src/domain/currentFlow.ts).
//
//   1. start the backend on :8000
//   2. node scripts/check-current-direction.mjs
//
// Expected everywhere: conventional current leaves the source's + terminal,
// runs through the circuit (high potential -> low through each part) and
// returns to its - terminal.
import { createServer } from "vite";

const server = await createServer({
  logLevel: "error",
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
});
const { computeWireCurrents, currentOutOfPin } = await server.ssrLoadModule("/src/domain/currentFlow.ts");
const { buildNetlist } = await server.ssrLoadModule("/src/domain/netlist.ts");

const part = (id, kind, params) => ({ id, kind, refId: id, x: 0, y: 0, rotation: 0, mirrored: false, params });
const wire = (id, [fc, fp], [tc, tp]) => ({ id, from: { componentId: fc, pinId: fp }, to: { componentId: tc, pinId: tp } });
const mA = (a) => `${(a * 1e3).toFixed(3)} mA`;
const SOURCES = new Set(["vsource_dc", "vsource_ac", "battery", "vsource_dep"]);

async function simulate(components, wires) {
  const netlist = buildNetlist(components, wires);
  const res = await fetch("http://127.0.0.1:8000/simulate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ netlist, analysis: { mode: "dc" } }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.message);
  return new Map(body.branch_analysis.map((b) => [b.component_id, b]));
}

/** Signed current along a wire: + = from -> to. */
const along = (f) => (f.direction === "a_to_b" ? f.amperes : f.direction === "b_to_a" ? -f.amperes : 0);

/** Generic checks for one simulated circuit. Returns a list of failures. */
function checkCircuit(parts, wires, branches, flows, log) {
  const fails = [];
  const byId = new Map(parts.map((p) => [p.id, p]));
  const tol = 1e-9;
  // Wires per pin, with the sign of "away from this pin".
  const atPin = new Map();
  for (const w of wires) {
    for (const [ref, away] of [[w.from, 1], [w.to, -1]]) {
      const k = `${ref.componentId}:${ref.pinId}`;
      if (!atPin.has(k)) atPin.set(k, []);
      atPin.get(k).push({ w, away });
    }
  }
  for (const [key, list] of atPin) {
    const [cid, pid] = key.split(":");
    const out = currentOutOfPin(byId.get(cid), pid, branches.get(cid));   // solved
    const shown = list.reduce((s, { w, away }) => s + away * along(flows.get(w.id)), 0);
    // KCL at the pin: what the part pushes out = what the wire arrows carry away.
    if (Math.abs(out - shown) > tol + 1e-9 * Math.abs(out)) {
      fails.push(`KCL at ${key}: part pushes out ${mA(out)} but arrows carry away ${mA(shown)}`);
    }
    // A pin with a single wire: that arrow's direction must be the sign of the solved current.
    if (list.length === 1 && Math.abs(out) > tol) {
      const { w, away } = list[0];
      const pointsAway = away * along(flows.get(w.id)) > 0;
      if (pointsAway !== out > 0) {
        fails.push(`arrow on ${w.id} at ${key} points ${pointsAway ? "away from" : "into"} the part, ` +
          `but the solved current ${mA(out)} ${out > 0 ? "leaves" : "enters"} it there`);
      }
    }
    // Sources: nothing flows back into + or out of - (single-source circuits).
    const comp = byId.get(cid);
    if (SOURCES.has(comp.kind) && parts.filter((p) => SOURCES.has(p.kind)).length === 1) {
      for (const { w, away } of list) {
        const a = away * along(flows.get(w.id));
        if (pid === "p1" && a < -tol) fails.push(`${w.id} points INTO ${cid}'s + terminal`);
        if (pid === "p2" && a > tol) fails.push(`${w.id} points OUT of ${cid}'s - terminal`);
      }
    }
  }
  return fails;
}

const CASES = [
  {
    name: "A. Series: V1 5V -> R1 1k -> R2 1k (R2 placed backwards, wires drawn both ways)",
    parts: [part("V1", "vsource_dc", { voltage: 5 }), part("R1", "resistor", { resistance: 1000 }),
            part("R2", "resistor", { resistance: 1000 })],
    wires: [wire("w1", ["R1", "p1"], ["V1", "p1"]), wire("w2", ["R1", "p2"], ["R2", "p2"]),
            wire("w3", ["V1", "p2"], ["R2", "p1"])],
  },
  {
    name: "B. Series-parallel: V1 9V -> R1 1k -> (R2 2k || R3 2k), junction wired as a chain",
    parts: [part("V1", "vsource_dc", { voltage: 9 }), part("R1", "resistor", { resistance: 1000 }),
            part("R2", "resistor", { resistance: 2000 }), part("R3", "resistor", { resistance: 2000 })],
    wires: [wire("s1", ["V1", "p1"], ["R1", "p1"]), wire("s2", ["R1", "p2"], ["R2", "p1"]),
            wire("s3", ["R2", "p1"], ["R3", "p1"]), wire("s4", ["R2", "p2"], ["R3", "p2"]),
            wire("s5", ["R3", "p2"], ["V1", "p2"])],
  },
  {
    // Nodes: A(+) B C D E G(-). Bridge R3 (B-C); several loops; unequal values.
    name: "C. 10-resistor bridge / multi-loop network, V1 12V",
    parts: [
      part("V1", "vsource_dc", { voltage: 12 }),
      part("R1", "resistor", { resistance: 100 }),  // A-B
      part("R2", "resistor", { resistance: 220 }),  // A-C
      part("R3", "resistor", { resistance: 330 }),  // B-C bridge
      part("R4", "resistor", { resistance: 470 }),  // B-D
      part("R5", "resistor", { resistance: 150 }),  // C-D (placed backwards: D-C)
      part("R6", "resistor", { resistance: 680 }),  // C-E
      part("R7", "resistor", { resistance: 100 }),  // D-E bridge
      part("R8", "resistor", { resistance: 560 }),  // D-G (placed backwards: G-D)
      part("R9", "resistor", { resistance: 270 }),  // E-G
      part("R10", "resistor", { resistance: 1000 }), // B-E
    ],
    wires: [
      // node A: V1+, R1.p1, R2.p1   (chain V1 -> R1 -> R2)
      wire("a1", ["V1", "p1"], ["R1", "p1"]), wire("a2", ["R1", "p1"], ["R2", "p1"]),
      // node B: R1.p2, R3.p1, R4.p1, R10.p1   (chain, drawn in mixed directions)
      wire("b1", ["R1", "p2"], ["R3", "p1"]), wire("b2", ["R4", "p1"], ["R3", "p1"]),
      wire("b3", ["R4", "p1"], ["R10", "p1"]),
      // node C: R2.p2, R3.p2, R5.p2 (R5 backwards), R6.p1   (star around R3.p2)
      wire("c1", ["R2", "p2"], ["R3", "p2"]), wire("c2", ["R3", "p2"], ["R5", "p2"]),
      wire("c3", ["R6", "p1"], ["R3", "p2"]),
      // node D: R4.p2, R5.p1, R7.p1, R8.p2 (R8 backwards)
      wire("d1", ["R4", "p2"], ["R5", "p1"]), wire("d2", ["R5", "p1"], ["R7", "p1"]),
      wire("d3", ["R8", "p2"], ["R7", "p1"]),
      // node E: R6.p2, R7.p2, R9.p1, R10.p2
      wire("e1", ["R6", "p2"], ["R7", "p2"]), wire("e2", ["R7", "p2"], ["R9", "p1"]),
      wire("e3", ["R10", "p2"], ["R9", "p1"]),
      // node G: R8.p1 (backwards), R9.p2, V1-
      wire("g1", ["R9", "p2"], ["R8", "p1"]), wire("g2", ["R8", "p1"], ["V1", "p2"]),
    ],
    spotNodes: {
      "B": ["R1:p2", "R3:p1", "R4:p1", "R10:p1"],
      "D": ["R4:p2", "R5:p1", "R7:p1", "R8:p2"],
      "E": ["R6:p2", "R7:p2", "R9:p1", "R10:p2"],
    },
  },
  {
    name: "D. Outer loop with the source flipped (+ wired to the bottom), plus a parallel leg",
    parts: [part("V1", "vsource_dc", { voltage: 5 }), part("R1", "resistor", { resistance: 500 }),
            part("R2", "resistor", { resistance: 1000 }), part("R3", "resistor", { resistance: 1000 })],
    wires: [wire("f1", ["R1", "p1"], ["V1", "p2"]), wire("f2", ["R1", "p2"], ["V1", "p1"]),
            wire("f3", ["V1", "p1"], ["R2", "p1"]), wire("f4", ["R2", "p2"], ["R3", "p1"]),
            wire("f5", ["R3", "p2"], ["V1", "p2"])],
  },
];

let failures = 0;
for (const c of CASES) {
  const branches = await simulate(c.parts, c.wires);
  const byId = new Map(c.parts.map((p) => [p.id, p]));
  const flows = computeWireCurrents(c.wires, byId, branches);
  console.log(`\n${c.name}`);
  for (const p of c.parts) {
    const b = branches.get(p.id);
    console.log(`   ${p.id.padEnd(3)} solved through-current ${mA(b.current_a).padStart(11)}  ${b.direction}`);
  }
  for (const w of c.wires) {
    const f = flows.get(w.id);
    const [from, to] = [`${w.from.componentId}.${w.from.pinId}`, `${w.to.componentId}.${w.to.pinId}`];
    const arrow = f.direction === "a_to_b" ? `${from} --> ${to}` : f.direction === "b_to_a" ? `${to} --> ${from}` : `${from} --- ${to}`;
    console.log(`   wire ${w.id.padEnd(3)} arrow ${arrow.padEnd(26)} ${mA(f.amperes)}`);
  }
  for (const [node, pins] of Object.entries(c.spotNodes ?? {})) {
    let into = 0, out = 0;
    const terms = [];
    for (const key of pins) {
      const [cid, pid] = key.split(":");
      const o = currentOutOfPin(byId.get(cid), pid, branches.get(cid));   // + = part pushes current into the node
      if (o > 0) into += o; else out -= o;
      terms.push(`${cid} ${o > 0 ? "in" : "out"} ${mA(Math.abs(o))}`);
    }
    console.log(`   KCL node ${node}: ${terms.join(", ")}  ->  in ${mA(into)} = out ${mA(out)} ${Math.abs(into - out) < 1e-9 ? "OK" : "MISMATCH"}`);
    if (Math.abs(into - out) >= 1e-9) failures++;
  }
  const fails = checkCircuit(c.parts, c.wires, branches, flows);
  failures += fails.length;
  console.log(fails.length ? fails.map((f) => `   FAIL ${f}`).join("\n")
    : `   PASS every arrow matches its solved current; KCL holds at all ${new Set(c.wires.flatMap((w) => [w.from, w.to].map((r) => r.componentId + r.pinId))).size} pins; nothing flows back into + or out of -`);
}
await server.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exitCode = failures ? 1 : 0;

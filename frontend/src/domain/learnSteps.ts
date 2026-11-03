// Step-by-step teaching walkthroughs (KCL, KVL, nodal analysis) built from
// the schematic and the last simulation's operating point. Pure data: the
// canvas (canvas/LearnOverlay.tsx) draws a step's highlights and the side
// card (components/LearnPanel.tsx) shows its text.

import type { BranchInfo } from "../api/simulate";
import type { ComponentInstance, ComponentKind, Wire } from "../types/circuit";
import { getDef } from "./componentDefs";
import { buildNetlist } from "./netlist";
import { currentOutOfPin, computeWireCurrents } from "./currentFlow";
import {
  orthogonalPath,
  pinDirection,
  resolvePinWorld,
  routedPath,
  waypointPath,
} from "../utils/geometry";
import { formatSIValue } from "../utils/units";

export type LearnMode = "kcl" | "kvl" | "nodal";

export const LEARN_MODE_LABEL: Record<LearnMode, string> = {
  kcl: "KCL",
  kvl: "KVL",
  nodal: "Nodal Analysis",
};

type Pt = { x: number; y: number };

/** Distinct hues that read on the dark canvas and stay clear of the
 *  white (current) and pale-yellow (voltage) the simulator already uses. */
export const LEARN_COLORS = [
  "#ff6b6b",
  "#4dabf7",
  "#69db7c",
  "#ffa94d",
  "#da77f2",
  "#3bc9db",
  "#f783ac",
  "#a9e34b",
];
const color = (i: number) => LEARN_COLORS[i % LEARN_COLORS.length];

// ── Step model ──────────────────────────────────────────────────────────────

/** A wire to light up; `points` are in grid units, from → to. */
export interface LearnWire {
  wireId: string;
  points: Pt[];
  color: string;
  /** Animate moving dashes along the wire in this direction. */
  flow?: "a_to_b" | "b_to_a";
}
export interface LearnHalo {
  componentId: string;
  color: string;
}
/** A value pill, centred at (x, y) in grid units. */
export interface LearnTag {
  x: number;
  y: number;
  text: string;
  color: string;
}
/** An arrowhead at (x, y) grid units, heading `angle` degrees. */
export interface LearnArrow {
  x: number;
  y: number;
  angle: number;
  color: string;
}
/** A loop drawn just inside its wires, with dashes moving around it. */
export interface LearnRing {
  segments: Pt[][];
  color: string;
  /** Dashes run along the segments' order (true) or against it. */
  forward: boolean;
}
export interface LearnBadge {
  x: number;
  y: number;
  text: string;
  color: string;
}
export interface EqTerm {
  text: string;
  color?: string;
}
export interface LearnDetail {
  label: string;
  text: string;
  color?: string;
}

export interface LearnStep {
  kicker: string;
  title: string;
  body: string[];
  details?: LearnDetail[];
  equation?: EqTerm[];
  result?: string;
  wires: LearnWire[];
  halos: LearnHalo[];
  tags: LearnTag[];
  arrows: LearnArrow[];
  rings: LearnRing[];
  badges: LearnBadge[];
}

function emptyStep(kicker: string, title: string, body: string[]): LearnStep {
  return { kicker, title, body, wires: [], halos: [], tags: [], arrows: [], rings: [], badges: [] };
}

// ── Formatting ──────────────────────────────────────────────────────────────

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";
const sub = (n: number) => String(n).replace(/\d/g, (d) => SUBSCRIPT[Number(d)]);

function fmtA(a: number, signed = false): string {
  const abs = Math.abs(a);
  const sign = signed ? (a < 0 ? "−" : "+") : a < 0 ? "−" : "";
  if (abs < 1e-12) return signed ? "0 A" : "0 A";
  const mag =
    abs >= 1 ? `${abs.toFixed(3)} A`
    : abs >= 1e-3 ? `${(abs * 1e3).toFixed(2)} mA`
    : abs >= 1e-6 ? `${(abs * 1e6).toFixed(2)} µA`
    : `${(abs * 1e9).toFixed(2)} nA`;
  return sign + mag;
}

function fmtV(v: number, signed = false): string {
  const abs = Math.abs(v);
  if (abs < 1e-3) return "0.00 V";
  const sign = signed ? (v < 0 ? "−" : "+") : v < 0 ? "−" : "";
  return abs >= 1 ? `${sign}${abs.toFixed(2)} V` : `${sign}${(abs * 1e3).toFixed(1)} mV`;
}

/** Bare number for substituted formulas, e.g. 5 → "5.00". */
const num = (v: number) => (Math.abs(v) < 1e-3 ? "0.00" : v.toFixed(2).replace("-", "−"));

const netName = (n: string) => (n === "0" ? "GND" : `N${n}`);
const nodeV = (n: string) => (n === "0" ? "0" : `V(${netName(n)})`);

const SOURCE_KINDS = new Set<ComponentKind>(["vsource_dc", "vsource_ac", "battery", "vsource_dep"]);

function valueText(c: ComponentInstance): string {
  const def = getDef(c.kind);
  const p = def.params[0];
  return p ? formatSIValue(c.params[p.key] ?? p.default, p.unit) : "";
}

// ── Circuit context ─────────────────────────────────────────────────────────

const pinKey = (componentId: string, pinId: string) => `${componentId}:${pinId}`;

interface WireHop {
  wire: Wire;
  other: string;
}

class CircuitCtx {
  byId: Map<string, ComponentInstance>;
  pinNet = new Map<string, string>();
  netPins = new Map<string, string[]>();
  netV = new Map<string, number>();
  pinPos = new Map<string, Pt>();
  pinDir = new Map<string, Pt>();
  adj = new Map<string, WireHop[]>();
  wireCurrents: ReturnType<typeof computeWireCurrents>;
  components: ComponentInstance[];
  wires: Wire[];
  branchMap: Map<string, BranchInfo>;

  constructor(components: ComponentInstance[], wires: Wire[], branchMap: Map<string, BranchInfo>) {
    this.components = components;
    this.wires = wires;
    this.branchMap = branchMap;
    this.byId = new Map(components.map((c) => [c.id, c]));
    const netlist = buildNetlist(components, wires);
    for (const nc of netlist.components) {
      getDef(this.byId.get(nc.id)!.kind).pins.forEach((p, i) =>
        this.pinNet.set(pinKey(nc.id, p.id), nc.nodes[i])
      );
    }
    for (const c of components) if (c.kind === "ground") this.pinNet.set(pinKey(c.id, "p1"), "0");
    for (const c of components) {
      for (const p of getDef(c.kind).pins) {
        const k = pinKey(c.id, p.id);
        this.pinPos.set(k, resolvePinWorld(c, p));
        this.pinDir.set(k, pinDirection(c, p));
        const net = this.pinNet.get(k);
        if (net === undefined) continue;
        if (!this.netPins.has(net)) this.netPins.set(net, []);
        this.netPins.get(net)!.push(k);
      }
    }
    for (const b of branchMap.values()) {
      this.netV.set(b.node_a, b.voltage_a);
      this.netV.set(b.node_b, b.voltage_b);
      b.pin_nodes?.forEach((n, i) => {
        const v = b.pin_voltages?.[i];
        if (v !== undefined) this.netV.set(n, v);
      });
    }
    this.netV.set("0", 0);
    for (const w of wires) {
      const a = pinKey(w.from.componentId, w.from.pinId);
      const b = pinKey(w.to.componentId, w.to.pinId);
      if (a === b) continue;
      if (!this.adj.has(a)) this.adj.set(a, []);
      if (!this.adj.has(b)) this.adj.set(b, []);
      this.adj.get(a)!.push({ wire: w, other: b });
      this.adj.get(b)!.push({ wire: w, other: a });
    }
    this.wireCurrents = computeWireCurrents(wires, this.byId, branchMap);
  }

  v(net: string) {
    return this.netV.get(net) ?? 0;
  }

  /** The drawn route of a wire, grid units, from → to (as WireView draws it). */
  wirePoints(w: Wire): Pt[] {
    const a = this.pinPos.get(pinKey(w.from.componentId, w.from.pinId))!;
    const b = this.pinPos.get(pinKey(w.to.componentId, w.to.pinId))!;
    const da = this.pinDir.get(pinKey(w.from.componentId, w.from.pinId));
    const db = this.pinDir.get(pinKey(w.to.componentId, w.to.pinId));
    if (!a || !b) return [];
    return w.route
      ? routedPath(a, b, da, db, w.route)
      : w.waypoints
        ? waypointPath(a, b, w.waypoints, da, db)
        : orthogonalPath(a, b, da, db);
  }

  wiresOfNet(net: string): Wire[] {
    return this.wires.filter((w) => this.pinNet.get(pinKey(w.from.componentId, w.from.pinId)) === net);
  }

  /** Wires (in travel order) leading from pin `a` to pin `b` inside a net. */
  wireRoute(a: string, b: string): { wire: Wire; forward: boolean }[] | null {
    if (a === b) return [];
    const prev = new Map<string, { hop: WireHop; from: string }>();
    const queue = [a];
    const seen = new Set([a]);
    while (queue.length) {
      const p = queue.shift()!;
      if (p === b) break;
      for (const hop of this.adj.get(p) ?? []) {
        if (seen.has(hop.other)) continue;
        seen.add(hop.other);
        prev.set(hop.other, { hop, from: p });
        queue.push(hop.other);
      }
    }
    if (!seen.has(b)) return null;
    const out: { wire: Wire; forward: boolean }[] = [];
    for (let p = b; p !== a; ) {
      const step = prev.get(p)!;
      out.unshift({
        wire: step.hop.wire,
        forward: pinKey(step.hop.wire.from.componentId, step.hop.wire.from.pinId) === step.from,
      });
      p = step.from;
    }
    return out;
  }

  /** A spot on open wire for a node's badge: above the longest wire run. */
  netAnchor(net: string): Pt {
    let best: Pt | null = null;
    let bestLen = -1;
    let horizontal = true;
    for (const w of this.wiresOfNet(net)) {
      const pts = this.wirePoints(w);
      for (let i = 0; i < pts.length - 1; i++) {
        const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
        if (len > bestLen) {
          bestLen = len;
          best = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
          horizontal = Math.abs(pts[i + 1].y - pts[i].y) < 1e-6;
        }
      }
    }
    if (best) return horizontal ? { x: best.x, y: best.y - 0.75 } : { x: best.x + 1.6, y: best.y };
    const p = this.pinPos.get(this.netPins.get(net)?.[0] ?? "") ?? { x: 0, y: 0 };
    return { x: p.x, y: p.y - 0.9 };
  }

  netWires(net: string, col: string, animate: boolean): LearnWire[] {
    return this.wiresOfNet(net).map((w) => {
      const flow = this.wireCurrents.get(w.id)?.direction;
      return {
        wireId: w.id,
        points: this.wirePoints(w),
        color: col,
        flow: animate && flow && flow !== "none" ? flow : undefined,
      };
    });
  }

  /** Non-ground nets in display order (N1, N2, …). */
  signalNets(): string[] {
    return [...this.netPins.keys()]
      .filter((n) => n !== "0")
      .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  }

  /** Parts that aren't two-terminal (transistors, op-amps). */
  multiPinParts(): ComponentInstance[] {
    return this.components.filter((c) => c.kind !== "ground" && getDef(c.kind).pins.length > 2);
  }
}

/** Where to put a value pill for a part: beside its body, toward `toward`. */
function tagSpot(c: ComponentInstance, toward?: Pt): Pt {
  const rot = ((c.rotation % 360) + 360) % 360;
  if (rot === 0 || rot === 180) {
    const below = toward ? toward.y >= c.y : true;
    return { x: c.x, y: below ? c.y + 1.25 : c.y - 2.4 };
  }
  if (rot === 90 || rot === 270) {
    const right = toward ? toward.x >= c.x : true;
    return { x: right ? c.x + 2.1 : c.x - 3.6, y: c.y };
  }
  return { x: c.x + 1.3, y: c.y + 1.1 };
}

// ── KCL ─────────────────────────────────────────────────────────────────────

/** Neutral highlight for the node itself, so every branch colour stays distinct. */
const NODE_COLOR = "#dee2e6";

function kclSteps(ctx: CircuitCtx): LearnStep[] {
  const nets = [...ctx.signalNets(), ...(ctx.netPins.has("0") ? ["0"] : [])];
  const intro = emptyStep("Introduction", "Kirchhoff's Current Law (KCL)", [
    "Charge can't pile up in a wire, so at every node the current flowing in equals the current flowing out: ΣI_in = ΣI_out (or ΣI = 0).",
    `This circuit has ${nets.length} node${nets.length === 1 ? "" : "s"}. Press Next to visit them one at a time — each branch current gets its own colour, with arrows showing which way it flows.`,
  ]);
  intro.badges = nets.map((n) => ({ ...ctx.netAnchor(n), text: netName(n), color: NODE_COLOR }));

  const steps: LearnStep[] = [intro];
  nets.forEach((net, ni) => {
    const step = emptyStep(`Node ${ni + 1} of ${nets.length}`, `KCL at node ${netName(net)}`, []);
    step.wires = ctx.netWires(net, NODE_COLOR, true);
    step.badges.push({ ...ctx.netAnchor(net), text: `${netName(net)} · ${fmtV(ctx.v(net))}`, color: NODE_COLOR });

    const ins: EqTerm[] = [];
    const outs: EqTerm[] = [];
    const inNames: string[] = [];
    const outNames: string[] = [];
    let sumIn = 0;
    let sumOut = 0;
    let bi = 0;
    for (const k of ctx.netPins.get(net) ?? []) {
      const [cid, pid] = k.split(":");
      const comp = ctx.byId.get(cid);
      const b = ctx.branchMap.get(cid);
      if (!comp || comp.kind === "ground" || !b) continue;
      const def = getDef(comp.kind);
      const pinName = def.pins.length > 2 ? `.${def.pins.find((p) => p.id === pid)?.name ?? pid}` : "";
      const label = `I(${comp.refId}${pinName})`;
      const col = color(bi++);
      const into = currentOutOfPin(comp, pid, b); // + = flows from the part into the node
      const pos = ctx.pinPos.get(k)!;
      const dir = ctx.pinDir.get(k)!;
      const dirAngle = (Math.atan2(dir.y, dir.x) * 180) / Math.PI;
      step.halos.push({ componentId: cid, color: col });
      if (Math.abs(into) > 1e-12) {
        step.arrows.push({
          x: pos.x + dir.x * 0.45,
          y: pos.y + dir.y * 0.45,
          angle: into > 0 ? dirAngle : dirAngle + 180,
          color: col,
        });
      }
      // Beside the arrow, never on it: below a horizontal pin's wire, to the
      // right of a vertical pin (left edge just clear of the wire).
      const text = `${label} ${fmtA(Math.abs(into))}`;
      const halfW = Math.max(36, text.length * 6.3 + 14) / 2 / 24;
      step.tags.push(
        dir.y !== 0
          ? { x: pos.x + 0.55 + halfW, y: pos.y + dir.y * 0.6, text, color: col }
          : { x: pos.x + dir.x * 0.6, y: pos.y + 0.85, text, color: col }
      );
      const term = { text: `${fmtA(Math.abs(into))} (${comp.refId}${pinName})`, color: col };
      if (into > 1e-12) {
        ins.push(term);
        inNames.push(label);
        sumIn += into;
      } else if (into < -1e-12) {
        outs.push(term);
        outNames.push(label);
        sumOut -= into;
      } else {
        step.details = [...(step.details ?? []), { label, text: "carries no current", color: col }];
      }
    }

    step.body = [
      net === "0"
        ? "Ground is a node too — KCL holds here exactly as everywhere else."
        : `Node ${netName(net)} sits at ${fmtV(ctx.v(net))}. Its wires are highlighted; the moving dashes show the current along them.`,
      inNames.length ? `Current flows IN through ${inNames.join(", ")}.` : "No current flows in.",
      outNames.length ? `Current flows OUT through ${outNames.join(", ")}.` : "No current flows out.",
      "KCL: (sum of currents in) = (sum of currents out).",
    ];
    const eq: EqTerm[] = [];
    ins.forEach((t, i) => eq.push(...(i ? [{ text: "+" }] : []), t));
    if (!ins.length) eq.push({ text: "0" });
    eq.push({ text: "=" });
    outs.forEach((t, i) => eq.push(...(i ? [{ text: "+" }] : []), t));
    if (!outs.length) eq.push({ text: "0" });
    step.equation = eq;
    const ok = Math.abs(sumIn - sumOut) <= Math.max(1e-9, 0.01 * Math.max(sumIn, sumOut));
    step.result = `ΣI_in = ${fmtA(sumIn)}   ΣI_out = ${fmtA(sumOut)}   ${ok ? "✓ balanced" : "≈ (rounding)"}`;
    steps.push(step);
  });
  return steps;
}

// ── KVL / mesh loops ────────────────────────────────────────────────────────

interface Edge {
  idx: number;
  comp: ComponentInstance;
  b: BranchInfo;
  pinA: string; // pin key of pin 1 (a)
  pinB: string; // pin key of pin 2 (b)
  na: string;
  nb: string;
}

/** One hop of a loop: through `edge`, entering at net `from`. */
interface Hop {
  edge: Edge;
  forward: boolean; // a → b
}

interface Loop {
  hops: Hop[];
  segments: Pt[][];
  wires: { wire: Wire; forward: boolean }[];
  poly: Pt[];
  area: number; // signed; > 0 = clockwise on screen
  centroid: Pt;
}

const hopFrom = (h: Hop) => (h.forward ? h.edge.na : h.edge.nb);
const hopTo = (h: Hop) => (h.forward ? h.edge.nb : h.edge.na);
const hopIn = (h: Hop) => (h.forward ? h.edge.pinA : h.edge.pinB);
const hopOut = (h: Hop) => (h.forward ? h.edge.pinB : h.edge.pinA);

function loopGeometry(ctx: CircuitCtx, hops: Hop[]): Loop {
  const segments: Pt[][] = [];
  const wires: { wire: Wire; forward: boolean }[] = [];
  const poly: Pt[] = [];
  hops.forEach((h, i) => {
    const pin = ctx.pinPos.get(hopIn(h))!;
    const pout = ctx.pinPos.get(hopOut(h))!;
    segments.push([pin, pout]);
    poly.push(pin, pout);
    const next = hops[(i + 1) % hops.length];
    const route = ctx.wireRoute(hopOut(h), hopIn(next));
    if (!route) return; // e.g. two separate ground symbols: no drawn path
    for (const r of route) {
      wires.push(r);
      const pts = ctx.wirePoints(r.wire);
      const seq = r.forward ? pts : [...pts].reverse();
      segments.push(seq);
      poly.push(...seq.slice(1));
    }
  });
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const cr = p.x * q.y - q.x * p.y;
    a2 += cr;
    cx += (p.x + q.x) * cr;
    cy += (p.y + q.y) * cr;
  }
  const centroid =
    Math.abs(a2) > 1e-9
      ? { x: cx / (3 * a2), y: cy / (3 * a2) }
      : {
          x: poly.reduce((s, p) => s + p.x, 0) / Math.max(1, poly.length),
          y: poly.reduce((s, p) => s + p.y, 0) / Math.max(1, poly.length),
        };
  return { hops, segments, wires, poly, area: a2 / 2, centroid };
}

/** All simple cycles of the node/branch graph (capped for big circuits). */
function enumerateCycles(nodeIds: string[], edges: Edge[], cap = 3000): Hop[][] {
  const index = new Map(nodeIds.map((n, i) => [n, i]));
  const inc = new Map<string, Edge[]>();
  for (const e of edges) {
    for (const n of [e.na, e.nb]) {
      if (!inc.has(n)) inc.set(n, []);
      inc.get(n)!.push(e);
    }
  }
  const found = new Map<string, Hop[]>();
  let budget = 200000;
  for (const s of nodeIds) {
    const si = index.get(s)!;
    const path: Hop[] = [];
    const used = new Set<number>();
    const onPath = new Set<string>([s]);
    const dfs = (at: string) => {
      if (found.size >= cap || --budget <= 0) return;
      for (const e of inc.get(at) ?? []) {
        if (used.has(e.idx)) continue;
        const forward = e.na === at;
        const to = forward ? e.nb : e.na;
        const hop = { edge: e, forward };
        if (to === s) {
          const cyc = [...path, hop];
          const key = cyc.map((h) => h.edge.idx).sort((x, y) => x - y).join(",");
          if (!found.has(key)) found.set(key, cyc);
          continue;
        }
        if (onPath.has(to) || index.get(to)! < si) continue;
        used.add(e.idx);
        onPath.add(to);
        path.push(hop);
        dfs(to);
        path.pop();
        onPath.delete(to);
        used.delete(e.idx);
      }
    };
    dfs(s);
  }
  return [...found.values()];
}

/** Gaussian elimination for a small dense system; null if singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Pull every point a little toward the centroid so loops sharing a wire
 *  are drawn side by side instead of on top of each other. */
function insetSegments(segments: Pt[][], c: Pt, d = 0.42): Pt[][] {
  return segments.map((seg) =>
    seg.map((p) => {
      const vx = c.x - p.x;
      const vy = c.y - p.y;
      const len = Math.hypot(vx, vy);
      return len > d * 2 ? { x: p.x + (vx / len) * d, y: p.y + (vy / len) * d } : p;
    })
  );
}

function kvlSteps(ctx: CircuitCtx, isAc: boolean): LearnStep[] {
  const edges: Edge[] = [];
  for (const c of ctx.components) {
    const def = getDef(c.kind);
    const b = ctx.branchMap.get(c.id);
    if (c.kind === "ground" || def.pins.length !== 2 || !b) continue;
    const pinA = pinKey(c.id, def.pins[0].id);
    const pinB = pinKey(c.id, def.pins[1].id);
    const na = ctx.pinNet.get(pinA);
    const nb = ctx.pinNet.get(pinB);
    if (na === undefined || nb === undefined || na === nb) continue;
    edges.push({ idx: edges.length, comp: c, b, pinA, pinB, na, nb });
  }
  const nodeIds = [...new Set(edges.flatMap((e) => [e.na, e.nb]))];

  // Connected pieces of the graph, for the loop count B − N + P.
  const parent = new Map(nodeIds.map((n) => [n, n]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  for (const e of edges) parent.set(find(e.na), find(e.nb));
  const pieces = new Set(nodeIds.map(find)).size;
  const wanted = edges.length - nodeIds.length + pieces;

  // Smallest-area cycles first, kept only while independent (GF(2) basis):
  // for a planar drawing this picks exactly the meshes — the "windows".
  const candidates = enumerateCycles(nodeIds, edges)
    .map((hops) => {
      let g = loopGeometry(ctx, hops);
      if (g.area < 0) {
        const rev = [...hops].reverse().map((h) => ({ edge: h.edge, forward: !h.forward }));
        g = loopGeometry(ctx, rev);
      }
      return g;
    })
    .sort((a, b) => Math.abs(a.area) - Math.abs(b.area) || a.hops.length - b.hops.length);
  const basis: { pivot: number; vec: Uint8Array }[] = [];
  const loops: Loop[] = [];
  for (const cand of candidates) {
    if (loops.length >= wanted) break;
    const v = new Uint8Array(edges.length);
    for (const h of cand.hops) v[h.edge.idx] ^= 1;
    for (const bv of basis) if (v[bv.pivot]) for (let i = 0; i < v.length; i++) v[i] ^= bv.vec[i];
    const pivot = v.indexOf(1);
    if (pivot < 0) continue;
    basis.push({ pivot, vec: v });
    loops.push(cand);
  }
  // Top-to-bottom, left-to-right reading order.
  loops.sort((a, b) => Math.round(a.centroid.y) - Math.round(b.centroid.y) || a.centroid.x - b.centroid.x);

  // Mesh currents J: branch current I_e = Σ_l s(l,e)·J_l (least squares).
  const m = loops.length;
  const S = loops.map((l) => {
    const s = new Map<number, number>();
    for (const h of l.hops) s.set(h.edge.idx, h.forward ? 1 : -1);
    return s;
  });
  let J: number[] | null = null;
  if (m > 0) {
    const A = Array.from({ length: m }, (_, i) =>
      Array.from({ length: m }, (_, j) => {
        let sum = 0;
        for (const [e, si] of S[i]) sum += si * (S[j].get(e) ?? 0);
        return sum;
      })
    );
    const rhs = S.map((s) => [...s].reduce((sum, [e, si]) => sum + si * edges[e].b.current_a, 0));
    J = solve(A, rhs);
    if (J) {
      const scale = Math.max(1e-9, ...edges.map((e) => Math.abs(e.b.current_a)));
      const fits = edges.every((e) => {
        const model = S.reduce((sum, s, l) => sum + (s.get(e.idx) ?? 0) * J![l], 0);
        return Math.abs(model - e.b.current_a) <= 0.02 * scale;
      });
      if (!fits || isAc) J = null;
    }
  }
  const loopName = (l: number) => `I${sub(l + 1)}`;

  const skipped = ctx.multiPinParts();
  const intro = emptyStep("Introduction", "Kirchhoff's Voltage Law (KVL)", [
    "Walk around any closed loop and add up every voltage you cross: the drops and the rises cancel, so ΣV = 0.",
    `This circuit has ${edges.length} branches and ${nodeIds.length} nodes, so it has ${edges.length} − ${nodeIds.length} + ${pieces} = ${wanted} independent loop${wanted === 1 ? "" : "s"} (meshes). Each loop gets its own colour; we walk each one clockwise.`,
    J
      ? "Each loop also carries its own loop (mesh) current. Where two loops share a part, that part's current is the difference of the two loop currents — that's how the current splits."
      : "",
    skipped.length
      ? `${skipped.map((c) => c.refId).join(", ")} ${skipped.length === 1 ? "isn't" : "aren't"} two-terminal, so loops through ${skipped.length === 1 ? "it are" : "them are"} left out.`
      : "",
    isAc ? "Values are AC peak amplitudes, so the sums only balance approximately." : "",
  ].filter(Boolean));
  intro.badges = loops.map((l, i) => ({ ...l.centroid, text: `Loop ${i + 1}`, color: color(i) }));
  if (!loops.length) {
    intro.body.push("No closed loop was found — connect the parts into a closed circuit and run the simulation again.");
    return [intro];
  }

  const steps: LearnStep[] = [intro];
  const sharedBy = new Map<number, number[]>();
  loops.forEach((l, li) => l.hops.forEach((h) => sharedBy.set(h.edge.idx, [...(sharedBy.get(h.edge.idx) ?? []), li])));

  loops.forEach((loop, li) => {
    const col = color(li);
    const step = emptyStep(`Loop ${li + 1} of ${loops.length}`, `KVL around Loop ${li + 1}`, []);
    const start = hopFrom(loop.hops[0]);
    step.body.push(
      `Start at node ${netName(start)} and walk clockwise. Crossing a part from + to − is a drop (+); from − to + is a rise (−).`
    );
    const jl = J?.[li];
    if (jl !== undefined) {
      step.body.push(
        `Loop current ${loopName(li)} = ${fmtA(Math.abs(jl))} flows ${jl >= 0 ? "clockwise ↻" : "counter-clockwise ↺"} around this loop.`
      );
    }
    step.wires = loop.wires.map((r) => ({ wireId: r.wire.id, points: ctx.wirePoints(r.wire), color: col }));
    step.rings = [{ segments: insetSegments(loop.segments, loop.centroid), color: col, forward: jl === undefined || jl >= 0 }];
    step.badges.push({
      ...loop.centroid,
      text: jl !== undefined ? `${loopName(li)} = ${fmtA(Math.abs(jl))} ${jl >= 0 ? "↻" : "↺"}` : `Loop ${li + 1} ↻`,
      color: col,
    });

    const details: LearnDetail[] = [];
    const eq: EqTerm[] = [];
    let sum = 0;
    loop.hops.forEach((h, hi) => {
      const c = h.edge.comp;
      const from = hopFrom(h);
      const to = hopTo(h);
      const drop = ctx.v(from) - ctx.v(to);
      const iAlong = h.edge.b.current_a * (h.forward ? 1 : -1);
      sum += drop;
      step.halos.push({ componentId: c.id, color: col });
      step.tags.push({ ...tagSpot(c, loop.centroid), text: `${c.refId}: ${fmtV(drop, true)}`, color: col });

      let text: string;
      if (c.kind === "resistor") {
        const r = c.params.resistance ?? 0;
        text =
          Math.abs(iAlong) < 1e-12
            ? `no current flows → no drop (0 V)`
            : `I = ${fmtA(Math.abs(iAlong))} ${iAlong > 0 ? "with" : "against"} the loop × ${formatSIValue(r, "ohm")} → ${iAlong > 0 ? "drop" : "rise"} ${fmtV(drop, true)}`;
      } else if (SOURCE_KINDS.has(c.kind)) {
        text = `${valueText(c)} source: we enter at ${drop < 0 ? "− and leave at + → rise" : "+ and leave at − → drop"} ${fmtV(drop, true)}`;
      } else if (c.kind === "capacitor") {
        text = `capacitor charged to ${fmtV(Math.abs(drop))} → ${fmtV(drop, true)}`;
      } else {
        text = `measured across it: ${fmtV(drop, true)}`;
      }
      const shared = (sharedBy.get(h.edge.idx) ?? []).filter((x) => x !== li);
      if (J && shared.length) {
        const parts = [li, ...shared].map((l) => {
          const s = loops[l].hops.find((x) => x.edge.idx === h.edge.idx)!.forward === h.forward ? 1 : -1;
          return { l, s };
        });
        const expr = parts.map((p, i) => `${p.s < 0 ? " − " : i ? " + " : ""}${loopName(p.l)}`).join("");
        text += `. Shared with Loop ${shared.map((l) => l + 1).join(", ")}: I(${c.refId}) = ${expr} = ${fmtA(Math.abs(iAlong))}`;
      }
      details.push({ label: c.refId, text, color: col });
      eq.push(...(hi ? [{ text: drop < 0 ? "−" : "+" }] : drop < 0 ? [{ text: "−" }] : []), {
        text: `${num(Math.abs(drop))} (${c.refId})`,
        color: col,
      });
    });
    eq.push({ text: "=" }, { text: num(sum) });
    step.details = details;
    step.equation = eq;
    step.result = `ΣV around Loop ${li + 1} = ${fmtV(sum)}  ${Math.abs(sum) < 0.02 ? "✓ KVL holds" : "≈ 0 (rounding)"}`;
    steps.push(step);
  });

  if (loops.length > 1) {
    const all = emptyStep("Summary", "All loops together", [
      "Every loop current at once. Where two coloured loops run side by side, that part carries the difference of the two loop currents — that's how the source current splits between the loops.",
    ]);
    loops.forEach((l, li) => {
      const jl = J?.[li];
      all.rings.push({ segments: insetSegments(l.segments, l.centroid), color: color(li), forward: jl === undefined || jl >= 0 });
      all.badges.push({
        ...l.centroid,
        text: jl !== undefined ? `${loopName(li)} = ${fmtA(Math.abs(jl))} ${jl >= 0 ? "↻" : "↺"}` : `Loop ${li + 1}`,
        color: color(li),
      });
    });
    all.details = edges
      .filter((e) => (sharedBy.get(e.idx)?.length ?? 0) > 0)
      .map((e) => {
        const ls = sharedBy.get(e.idx)!;
        return {
          label: e.comp.refId,
          text: `${fmtA(Math.abs(e.b.current_a))}${ls.length > 1 ? ` — shared by Loops ${ls.map((l) => l + 1).join(" & ")}` : ` — Loop ${ls[0] + 1} only`}`,
          color: color(ls[0]),
        };
      });
    steps.push(all);
  }
  return steps;
}

// ── Nodal analysis ──────────────────────────────────────────────────────────

const REF_COLOR = "#868e96";

function nodalSteps(ctx: CircuitCtx, isAc: boolean): LearnStep[] {
  const nets = ctx.signalNets();
  const steps: LearnStep[] = [];

  const intro = emptyStep("Step 1", "Pick the reference node", [
    "Nodal analysis finds every node voltage. First choose one node as the 0 V reference — usually ground.",
    `That leaves ${nets.length} unknown node voltage${nets.length === 1 ? "" : "s"}: ${nets.map(nodeV).join(", ") || "none"}.`,
    "Then at each unknown node write KCL with every current leaving the node expressed through node voltages — for a resistor, (V_node − V_other) / R — set the sum to zero, and solve.",
    isAc ? "Values are AC peak amplitudes, so the sums only balance approximately." : "",
  ].filter(Boolean));
  if (ctx.netPins.has("0")) {
    intro.wires = ctx.netWires("0", REF_COLOR, false);
    intro.badges.push({ ...ctx.netAnchor("0"), text: "GND = 0 V (reference)", color: REF_COLOR });
  }
  steps.push(intro);

  nets.forEach((net, ni) => {
    const step = emptyStep(`Node ${ni + 1} of ${nets.length}`, `Node equation at ${netName(net)}`, []);
    step.wires = ctx.netWires(net, NODE_COLOR, true);
    step.badges.push({ ...ctx.netAnchor(net), text: `${nodeV(net)} = ?`, color: NODE_COLOR });

    const details: LearnDetail[] = [];
    const eq: EqTerm[] = [];
    let sum = 0;
    let bi = 0;
    const fixedBy: string[] = [];
    const shownNeighbours = new Set<string>();
    for (const k of ctx.netPins.get(net) ?? []) {
      const [cid, pid] = k.split(":");
      const comp = ctx.byId.get(cid);
      const b = ctx.branchMap.get(cid);
      if (!comp || comp.kind === "ground" || !b) continue;
      const def = getDef(comp.kind);
      const col = color(bi++);
      const leaving = -currentOutOfPin(comp, pid, b);
      sum += leaving;
      step.halos.push({ componentId: cid, color: col });
      step.tags.push({ ...tagSpot(comp), text: `${comp.refId}: ${fmtA(leaving, true)}`, color: col });

      let text: string;
      if (def.pins.length === 2) {
        const otherPin = def.pins.find((p) => p.id !== pid)!;
        const other = ctx.pinNet.get(pinKey(cid, otherPin.id)) ?? "0";
        if (other !== net && !shownNeighbours.has(other)) {
          shownNeighbours.add(other);
          step.badges.push({
            ...ctx.netAnchor(other),
            text: other === "0" ? "GND = 0 V" : `${nodeV(other)} = ${fmtV(ctx.v(other))}`,
            color: col,
          });
          step.wires.push(...ctx.netWires(other, col, false));
        }
        if (comp.kind === "resistor") {
          const r = comp.params.resistance ?? 0;
          text = `(${nodeV(net)} − ${nodeV(other)}) / ${comp.refId} = (${num(ctx.v(net))} − ${num(ctx.v(other))}) / ${formatSIValue(r, "ohm")} = ${fmtA(leaving, true)}`;
        } else if (SOURCE_KINDS.has(comp.kind)) {
          const pinIsPlus = def.pins[0].id === pid;
          fixedBy.push(
            `${comp.refId} fixes ${nodeV(net)} = ${nodeV(other)} ${pinIsPlus ? "+" : "−"} ${valueText(comp)} = ${fmtV(ctx.v(net))}`
          );
          text = `voltage source — its current isn't set by Ohm's law; from the solution it carries ${fmtA(leaving, true)} away from the node`;
        } else if (comp.kind === "capacitor") {
          text = isAc ? `capacitor: ${fmtA(leaving, true)} (from the AC solution)` : "capacitor = open circuit in DC → 0 A";
        } else if (comp.kind === "inductor") {
          text = isAc ? `inductor: ${fmtA(leaving, true)} (from the AC solution)` : `inductor = short in DC, carries ${fmtA(leaving, true)}`;
        } else {
          text = `non-linear part (${def.label.toLowerCase()}): ${fmtA(leaving, true)} from the solution`;
        }
      } else {
        const pinName = def.pins.find((p) => p.id === pid)?.name ?? pid;
        text = `${def.label} pin ${pinName}: ${fmtA(leaving, true)} from the solution`;
      }
      details.push({ label: comp.refId, text, color: col });
      eq.push(...(eq.length ? [{ text: leaving < 0 ? "−" : "+" }] : leaving < 0 ? [{ text: "−" }] : []), {
        text: `${fmtA(Math.abs(leaving))} (${comp.refId})`,
        color: col,
      });
    }
    eq.push({ text: "=" }, { text: "0" });

    step.body.push(`Write every current leaving ${netName(net)} in terms of node voltages and set their sum to zero (KCL).`);
    if (fixedBy.length) {
      step.body.push(
        `A voltage source touches this node, so its voltage is known straight away: ${fixedBy.join("; ")}. (If the source's other end is another unknown node, both nodes form a supernode.)`
      );
    }
    step.body.push(`Solving the equations gives ${nodeV(net)} = ${fmtV(ctx.v(net))}.`);
    step.details = details;
    step.equation = eq;
    step.result = `Σ I_leaving = ${fmtA(sum)}   →   ${nodeV(net)} = ${fmtV(ctx.v(net))}`;
    steps.push(step);
  });

  const done = emptyStep("Solution", "All node voltages", [
    "Every node voltage solved. With them, any branch current follows from Ohm's law: I = (V_a − V_b) / R.",
  ]);
  if (ctx.netPins.has("0")) done.badges.push({ ...ctx.netAnchor("0"), text: "GND = 0 V", color: REF_COLOR });
  nets.forEach((n, i) => {
    done.wires.push(...ctx.netWires(n, color(i), false));
    done.badges.push({ ...ctx.netAnchor(n), text: `${nodeV(n)} = ${fmtV(ctx.v(n))}`, color: color(i) });
  });
  done.details = nets.map((n, i) => ({ label: netName(n), text: fmtV(ctx.v(n)), color: color(i) }));
  steps.push(done);
  return steps;
}

// ── Entry point ─────────────────────────────────────────────────────────────

export function buildLearnSteps(
  mode: LearnMode,
  components: ComponentInstance[],
  wires: Wire[],
  branchMap: Map<string, BranchInfo>,
  isAc: boolean
): LearnStep[] {
  const ctx = new CircuitCtx(components, wires, branchMap);
  if (mode === "kcl") return kclSteps(ctx);
  if (mode === "kvl") return kvlSteps(ctx, isAc);
  return nodalSteps(ctx, isAc);
}

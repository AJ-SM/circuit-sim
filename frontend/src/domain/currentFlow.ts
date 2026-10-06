import type { BranchInfo } from "../api/simulate";
import type { ComponentInstance, Wire } from "../types/circuit";
import { getDef } from "./componentDefs";

/**
 * Current-direction convention (conventional current, as in physics texts):
 *
 * Every part's `current_a` from the backend is the current flowing THROUGH
 * the part from its first pin (a) to its second pin (b); positive means
 * a → b. That holds for sources too, so a source delivering power reports a
 * negative current: inside it, current rises from − to +, and outside it
 * leaves the + terminal, runs through the circuit and returns to −. Through
 * a resistor (or any passive part) it runs from the higher potential to the
 * lower.
 */

/** Current leaving `component` at `pinId` into the wire attached there
 *  (amperes; negative = current flows from the wire into the part). */
export function currentOutOfPin(
  component: ComponentInstance,
  pinId: string,
  branch: BranchInfo
): number {
  const pins = getDef(component.kind).pins;
  const idx = pins.findIndex((p) => p.id === pinId);
  // Through-current a → b enters at pin a and leaves at pin b.
  if (idx === 0) return -branch.current_a;
  if (idx === 1) return branch.current_a;
  return 0;
}

export interface WireCurrent {
  /** Magnitude in amperes. */
  amperes: number;
  /** Relative to the wire's own from → to direction. */
  direction: "a_to_b" | "b_to_a" | "none";
}

const pinKey = (ref: Wire["from"]) => `${ref.componentId}:${ref.pinId}`;

/**
 * The current along every wire, by Kirchhoff's current law on the wiring.
 *
 * The wires joining one electrical node form a small graph whose vertices
 * are pins. Each pin injects the current its part pushes out at that pin
 * (currentOutOfPin). In a tree-shaped node — the normal case — the current
 * along a wire is exactly the total injected on one side of it, so
 * junctions, bridges and long pin-to-pin chains all come out right. A pin
 * whose part has no solved current (a ground symbol) takes whatever balances
 * its node. Wires that close a loop of wire inside one node have no
 * determined current and are reported as carrying none.
 */
export function computeWireCurrents(
  wires: Wire[],
  componentsById: Map<string, ComponentInstance>,
  branchMap: Map<string, BranchInfo>
): Map<string, WireCurrent> {
  const result = new Map<string, WireCurrent>();
  const adj = new Map<string, { wire: Wire; other: string }[]>();
  for (const w of wires) {
    const a = pinKey(w.from), b = pinKey(w.to);
    if (a === b) continue;
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push({ wire: w, other: b });
    adj.get(b)!.push({ wire: w, other: a });
  }

  const injection = (key: string): number | undefined => {
    const [componentId, pinId] = key.split(":");
    const comp = componentsById.get(componentId);
    const branch = branchMap.get(componentId);
    if (!comp || !branch || getDef(comp.kind).pins.length < 2) return undefined;
    return currentOutOfPin(comp, pinId, branch);
  };

  const seen = new Set<string>();
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    // Spanning tree of this node's wiring (BFS), remembering each pin's
    // parent wire; wires outside the tree close a loop of wire.
    const pins: string[] = [start];
    const parent = new Map<string, { wire: Wire; parent: string } | null>([[start, null]]);
    const treeWires = new Set<string>();
    seen.add(start);
    for (let i = 0; i < pins.length; i++) {
      for (const { wire, other } of adj.get(pins[i])!) {
        if (seen.has(other)) continue;
        seen.add(other);
        parent.set(other, { wire, parent: pins[i] });
        treeWires.add(wire.id);
        pins.push(other);
      }
    }

    // Injections; a single unknown pin (e.g. a ground symbol) balances the node.
    const inj = new Map<string, number>();
    const unknown: string[] = [];
    for (const p of pins) {
      const v = injection(p);
      if (v === undefined) unknown.push(p);
      else inj.set(p, v);
    }
    if (unknown.length > 1) continue;            // undetermined: leave these wires unset
    if (unknown.length === 1) {
      let sum = 0;
      for (const v of inj.values()) sum += v;
      inj.set(unknown[0], -sum);
    }

    // Leaves first: the current a pin's subtree pushes up its parent wire.
    const subtree = new Map<string, number>();
    for (let i = pins.length - 1; i >= 0; i--) {
      const p = pins[i];
      const total = (subtree.get(p) ?? 0) + (inj.get(p) ?? 0);
      const up = parent.get(p);
      if (!up) continue;
      subtree.set(up.parent, (subtree.get(up.parent) ?? 0) + total);
      // `total` flows from p toward its parent along up.wire.
      const along = pinKey(up.wire.from) === p ? total : -total;   // + = from → to
      const amperes = Math.abs(along);
      result.set(up.wire.id, {
        amperes,
        direction: amperes < 1e-15 ? "none" : along > 0 ? "a_to_b" : "b_to_a",
      });
    }
    for (const p of pins) {
      for (const { wire } of adj.get(p)!) {
        if (!treeWires.has(wire.id) && !result.has(wire.id)) {
          result.set(wire.id, { amperes: 0, direction: "none" });
        }
      }
    }
  }
  return result;
}

import type { ComponentInstance, Wire } from "../types/circuit";
import { getDef } from "./componentDefs";

/** One placed component as the backend will see it: no geometry, just
 *  electrical facts. `nodes` lists the net name for each pin, in the
 *  same order as the component's pin definitions. */
export interface NetlistComponent {
  id: string;
  ref: string;
  type: string;
  nodes: string[];
  params: Record<string, number>;
}

export interface Netlist {
  version: 1;
  components: NetlistComponent[];
  nets: string[];
}

const SOURCE_KINDS = new Set<string>(["vsource_dc", "vsource_ac", "battery", "vsource_dep"]);

/** Union-find over "componentId:pinId" keys, merged by wires, so every
 *  electrically-connected group of pins collapses into one net name.
 *  Any pin touching a `ground` component's pin is forced onto net "0",
 *  matching the SPICE convention for the reference node. */
export function buildNetlist(
  components: ComponentInstance[],
  wires: Wire[]
): Netlist {
  const key = (componentId: string, pinId: string) => `${componentId}:${pinId}`;

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  // Seed every pin so isolated (unwired) pins still get their own net.
  for (const c of components) {
    for (const pin of getDef(c.kind).pins) {
      find(key(c.id, pin.id));
    }
  }
  for (const w of wires) {
    union(key(w.from.componentId, w.from.pinId), key(w.to.componentId, w.to.pinId));
  }

  // Assign readable net names: ground-connected nets become "0"; the
  // rest are numbered in first-seen order for stable, short JSON.
  const rootToName = new Map<string, string>();
  const groundRoots = new Set<string>();
  for (const c of components) {
    if (c.kind === "ground") {
      groundRoots.add(find(key(c.id, "p1")));
    }
  }
  // No ground drawn: use a hidden default reference so the circuit can
  // still be simulated. Tie the negative terminal of the first source to
  // "0" (the usual choice), falling back to the first device's last pin.
  if (groundRoots.size === 0) {
    const devices = components.filter((c) => c.kind !== "ground");
    const source = devices.find((c) => SOURCE_KINDS.has(c.kind));
    const anchor = source ?? devices[0];
    if (anchor) {
      const pins = getDef(anchor.kind).pins;
      groundRoots.add(find(key(anchor.id, pins[pins.length - 1].id)));
    }
  }
  for (const root of groundRoots) rootToName.set(root, "0");

  let nextNetNumber = 1;
  const nameOf = (componentId: string, pinId: string) => {
    const root = find(key(componentId, pinId));
    if (!rootToName.has(root)) {
      rootToName.set(root, String(nextNetNumber++));
    }
    return rootToName.get(root)!;
  };

  const netlistComponents: NetlistComponent[] = components
    .filter((c) => c.kind !== "ground") // ground is a node marker, not a device
    .map((c) => {
      const def = getDef(c.kind);
      return {
        id: c.id,
        ref: c.refId,
        type: c.kind,
        nodes: def.pins.map((p) => nameOf(c.id, p.id)),
        params: c.params,
      };
    });

  const nets = Array.from(new Set(Array.from(rootToName.values()))).sort(
    (a, b) => (a === "0" ? -1 : b === "0" ? 1 : Number(a) - Number(b))
  );

  return { version: 1, components: netlistComponents, nets };
}

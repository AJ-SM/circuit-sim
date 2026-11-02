import type { ComponentInstance, Wire } from "../types/circuit";
import { getDef } from "../domain/componentDefs";
import { orthogonalPath, pinDirection, resolvePinWorld, routedPath, waypointPath } from "./geometry";

/** A placed circuit reduced to what it looks like on the canvas: every
 *  part's pins at their grid positions (by name, e.g. "B", "C", "E") and
 *  every wire's routed path, computed with the same geometry the canvas
 *  draws with (resolvePinWorld, orthogonalPath / routedPath). The backend's
 *  /render-placement draws it as an image, to check placement against the
 *  source drawing without a browser. */
export interface PlacementSnapshot {
  components: {
    ref: string;
    kind: string;
    x: number;
    y: number;
    rotation: number;
    mirrored: boolean;
    pins: { name: string; x: number; y: number }[];
  }[];
  wires: { points: { x: number; y: number }[] }[];
}

export function placementSnapshot(components: ComponentInstance[], wires: Wire[]): PlacementSnapshot {
  const byId = new Map(components.map((c) => [c.id, c]));
  const pinInfo = (componentId: string, pinId: string) => {
    const comp = byId.get(componentId);
    const pin = comp && getDef(comp.kind).pins.find((p) => p.id === pinId);
    return comp && pin ? { at: resolvePinWorld(comp, pin), dir: pinDirection(comp, pin) } : null;
  };
  return {
    components: components.map((c) => ({
      ref: c.refId,
      kind: c.kind,
      x: c.x,
      y: c.y,
      rotation: c.rotation,
      mirrored: c.mirrored,
      pins: getDef(c.kind).pins.map((p) => ({ name: p.name, ...resolvePinWorld(c, p) })),
    })),
    wires: wires.flatMap((w) => {
      const a = pinInfo(w.from.componentId, w.from.pinId);
      const b = pinInfo(w.to.componentId, w.to.pinId);
      if (!a || !b) return [];
      const points = w.route
        ? routedPath(a.at, b.at, a.dir, b.dir, w.route)
        : w.waypoints
          ? waypointPath(a.at, b.at, w.waypoints, a.dir, b.dir)
          : orthogonalPath(a.at, b.at, a.dir, b.dir);
      return [{ points }];
    }),
  };
}

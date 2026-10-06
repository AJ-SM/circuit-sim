import { create } from "zustand";
import { v4 as uuid } from "uuid";
import type {
  ComponentInstance,
  ComponentKind,
  PinRef,
  Rotation,
  Wire,
  WireRoute,
} from "../types/circuit";
import { getDef } from "../domain/componentDefs";
import { snap } from "../utils/geometry";
import { buildNetlist } from "../domain/netlist";
import { runSimulation, type SimulationResult } from "../api/simulate";
import {
  DEFAULT_SIM_CONFIG,
  type SimulationConfig,
} from "../domain/simulationConfig";
import {
  loadNetlistJson,
  type JsonNetlist,
  type RawWireSegment,
  type RawJunction,
} from "../utils/loadNetlistJson";

export type SelectionRef =
  | { type: "component"; id: string }
  | { type: "wire"; id: string }
  | null;

/** While the user is dragging a new wire off a pin, we track it here
 *  rather than in the document, since it isn't a real wire yet. */
export interface PendingWire {
  from: PinRef;
  cursor: { x: number; y: number };
}

export type WireLabelMode = "off" | "current" | "voltage" | "both";

/** What the canvas draws on top of the schematic after a simulation. */
export interface DisplayOptions {
  /** Flow arrows and moving dashes along wires that carry current. */
  currentDirection: boolean;
  /** Colour wires by potential, high (warm) to low (cool). */
  voltageDirection: boolean;
  /** Value tag on every wire. */
  wireLabels: WireLabelMode;
  /** Ref and value text next to each component. */
  componentLabels: boolean;
}

// Current-direction arrows start on; the other on-wire overlays start
// hidden (values are opened per part with Inspect, or for every wire from
// the Display section).
export const DEFAULT_DISPLAY: DisplayOptions = {
  currentDirection: true,
  voltageDirection: false,
  wireLabels: "off",
  componentLabels: true,
};

interface CircuitState {
  components: ComponentInstance[];
  wires: Wire[];
  /** Raw wire segments from the loaded netlist JSON, in grid units. Drawn
   *  directly on the canvas so the exact detected wire geometry is preserved. */
  rawWireSegments: RawWireSegment[];
  /** Junction dots from the loaded netlist JSON, in grid units. */
  rawJunctions: RawJunction[];
  /** The original parsed JsonNetlist — kept so CircuitJsViewer can build the
   *  Falstad text without re-reading the file. */
  netlistRaw: JsonNetlist | null;
  /** Bumped whenever the whole scene is replaced (clear / load / generate),
   *  so view-only state such as canvas pan/zoom can reset with it. */
  sceneVersion: number;
  selection: SelectionRef;
  pendingWire: PendingWire | null;
  simStatus: "idle" | "running" | "done" | "error";
  simResult: SimulationResult | null;
  simError: string | null;
  simConfig: SimulationConfig;
  setSimConfig: (config: SimulationConfig) => void;
  toggledBadgeIds: string[];
  showAllBadges: boolean;
  toggleComponentBadge: (id: string) => void;
  setShowAllBadges: (show: boolean) => void;
  clearToggledBadges: () => void;
  /** Toolbar eye: while on, clicking a part shows / hides its V and I. */
  inspectMode: boolean;
  setInspectMode: (on: boolean) => void;
  display: DisplayOptions;
  setDisplay: (patch: Partial<DisplayOptions>) => void;

  addComponent: (kind: ComponentKind, x: number, y: number) => void;
  moveComponent: (id: string, x: number, y: number) => void;
  setWireRoute: (id: string, route: WireRoute) => void;
  /** Turn clockwise by `step` degrees (90 by default, 45 for a diagonal). */
  rotateComponent: (id: string, step?: 45 | 90) => void;
  mirrorComponent: (id: string) => void;
  updateParam: (id: string, key: string, value: number) => void;
  select: (ref: SelectionRef) => void;
  deleteSelected: () => void;

  startWire: (from: PinRef, cursor: { x: number; y: number }) => void;
  updateWireCursor: (cursor: { x: number; y: number }) => void;
  finishWire: (to: PinRef | null) => void;
  cancelWire: () => void;

  clearAll: () => void;
  loadNetlist: (json: JsonNetlist) => string[]; // returns list of skipped ref_des
  runSimulate: () => Promise<void>;
}

function nextRefId(components: ComponentInstance[], kind: ComponentKind) {
  const prefix = getDef(kind).refPrefix;
  const used = new Set(
    components.filter((c) => c.kind === kind).map((c) => c.refId)
  );
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export const useCircuitStore = create<CircuitState>((set, get) => ({
  components: [],
  wires: [],
  rawWireSegments: [],
  rawJunctions: [],
  netlistRaw: null,
  sceneVersion: 0,
  selection: null,
  pendingWire: null,
  simStatus: "idle",
  simResult: null,
  simError: null,
  simConfig: DEFAULT_SIM_CONFIG,
  setSimConfig: (config) => set({ simConfig: config }),
  toggledBadgeIds: [],
  showAllBadges: false,
  toggleComponentBadge: (id: string) =>
    set((s) => {
      const exists = s.toggledBadgeIds.includes(id);
      return {
        toggledBadgeIds: exists
          ? s.toggledBadgeIds.filter((x) => x !== id)
          : [...s.toggledBadgeIds, id],
      };
    }),
  setShowAllBadges: (show: boolean) => set({ showAllBadges: show }),
  clearToggledBadges: () => set({ toggledBadgeIds: [] }),
  inspectMode: false,
  // Turning the eye off also closes any stats opened with it.
  setInspectMode: (on) => set(on ? { inspectMode: true } : { inspectMode: false, toggledBadgeIds: [] }),
  display: DEFAULT_DISPLAY,
  setDisplay: (patch) => set((s) => ({ display: { ...s.display, ...patch } })),

  addComponent: (kind, x, y) => {
    const def = getDef(kind);
    const instance: ComponentInstance = {
      id: uuid(),
      kind,
      refId: nextRefId(get().components, kind),
      x: snap(x),
      y: snap(y),
      rotation: 0,
      mirrored: false,
      params: Object.fromEntries(def.params.map((p) => [p.key, p.default])),
    };
    set((s) => ({
      components: [...s.components, instance],
      selection: { type: "component", id: instance.id },
    }));
  },

  moveComponent: (id, x, y) =>
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id ? { ...c, x: snap(x), y: snap(y) } : c
      ),
    })),

  setWireRoute: (id, route) =>
    set((s) => ({
      wires: s.wires.map((w) => (w.id === id ? { ...w, route } : w)),
    })),

  rotateComponent: (id, step = 90) =>
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id
          ? { ...c, rotation: ((c.rotation + step) % 360) as Rotation }
          : c
      ),
    })),

  mirrorComponent: (id) =>
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id ? { ...c, mirrored: !c.mirrored } : c
      ),
    })),

  updateParam: (id, key, value) =>
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id ? { ...c, params: { ...c.params, [key]: value } } : c
      ),
    })),

  select: (ref) => set({ selection: ref }),

  deleteSelected: () => {
    const { selection } = get();
    if (!selection) return;
    if (selection.type === "component") {
      set((s) => ({
        components: s.components.filter((c) => c.id !== selection.id),
        wires: s.wires.filter(
          (w) =>
            w.from.componentId !== selection.id &&
            w.to.componentId !== selection.id
        ),
        selection: null,
      }));
    } else {
      set((s) => ({
        wires: s.wires.filter((w) => w.id !== selection.id),
        selection: null,
      }));
    }
  },

  startWire: (from, cursor) => set({ pendingWire: { from, cursor } }),
  updateWireCursor: (cursor) =>
    set((s) =>
      s.pendingWire ? { pendingWire: { ...s.pendingWire, cursor } } : {}
    ),

  finishWire: (to) => {
    const pending = get().pendingWire;
    set({ pendingWire: null });
    if (!pending || !to) return;
    // Ignore no-op connections to the same pin, and exact duplicate wires.
    if (
      pending.from.componentId === to.componentId &&
      pending.from.pinId === to.pinId
    )
      return;
    const dup = get().wires.some(
      (w) =>
        (samePin(w.from, pending.from) && samePin(w.to, to)) ||
        (samePin(w.from, to) && samePin(w.to, pending.from))
    );
    if (dup) return;
    const wire: Wire = { id: uuid(), from: pending.from, to };
    set((s) => ({ wires: [...s.wires, wire] }));
  },

  cancelWire: () => set({ pendingWire: null }),

  clearAll: () =>
    set((s) => ({
      sceneVersion: s.sceneVersion + 1,
      components: [],
      wires: [],
      rawWireSegments: [],
      rawJunctions: [],
      netlistRaw: null,
      selection: null,
      pendingWire: null,
      simStatus: "idle",
      simResult: null,
      simError: null,
      toggledBadgeIds: [],
      showAllBadges: false,
    })),

  loadNetlist: (json) => {
    const { components, wires, skipped, rawWireSegments, rawJunctions } = loadNetlistJson(json);
    set((s) => ({
      sceneVersion: s.sceneVersion + 1,
      components,
      wires,
      rawWireSegments,
      rawJunctions,
      netlistRaw: json,
      selection: null,
      pendingWire: null,
      simStatus: "idle",
      simResult: null,
      simError: null,
      toggledBadgeIds: [],
      showAllBadges: false,
    }));
    return skipped;
  },

  runSimulate: async () => {
    const { components, wires, simConfig } = get();
    const netlist = buildNetlist(components, wires);
    set({ simStatus: "running", simError: null });
    try {
      const result = await runSimulation(netlist, simConfig);
      if (!result.ok) {
        set({ simStatus: "error", simResult: null, simError: result.message ?? "Simulation failed." });
        return;
      }
      set({ simStatus: "done", simResult: result });
    } catch (err) {
      set({
        simStatus: "error",
        simError: err instanceof Error ? err.message : String(err),
      });
    }
  },
}));

function samePin(a: PinRef, b: PinRef) {
  return a.componentId === b.componentId && a.pinId === b.pinId;
}

import type { ComponentDef, ComponentKind } from "../types/circuit";

/**
 * Single source of truth for every component kind the app knows about.
 * To add a new component later: add a ComponentKind, add an entry here,
 * and add a symbol drawing in canvas/symbols.tsx keyed by `symbolId`.
 * Nothing else in the app needs to change.
 *
 * All two-terminal parts use the same local pin layout by convention:
 * pin "p1" at (-1, 0), pin "p2" at (1, 0), so wiring/rotation logic can
 * stay generic instead of special-casing each kind.
 */
export const COMPONENT_DEFS: Record<ComponentKind, ComponentDef> = {
  resistor: {
    kind: "resistor",
    label: "Resistor",
    symbolId: "resistor",
    size: { w: 2, h: 1 },
    pins: [
      { id: "p1", name: "A", local: { x: -1, y: 0 } },
      { id: "p2", name: "B", local: { x: 1, y: 0 } },
    ],
    params: [
      { key: "resistance", label: "Resistance", unit: "ohm", default: 1000 },
    ],
    refPrefix: "R",
  },

  capacitor: {
    kind: "capacitor",
    label: "Capacitor",
    symbolId: "capacitor",
    size: { w: 2, h: 1 },
    pins: [
      { id: "p1", name: "A", local: { x: -1, y: 0 } },
      { id: "p2", name: "B", local: { x: 1, y: 0 } },
    ],
    params: [
      { key: "capacitance", label: "Capacitance", unit: "farad", default: 1e-6 },
    ],
    refPrefix: "C",
  },

  inductor: {
    kind: "inductor",
    label: "Inductor",
    symbolId: "inductor",
    size: { w: 2, h: 1 },
    pins: [
      { id: "p1", name: "A", local: { x: -1, y: 0 } },
      { id: "p2", name: "B", local: { x: 1, y: 0 } },
    ],
    params: [
      { key: "inductance", label: "Inductance", unit: "henry", default: 1e-3 },
    ],
    refPrefix: "L",
  },

  vsource_dc: {
    kind: "vsource_dc",
    label: "DC Voltage Source",
    symbolId: "vsource_dc",
    size: { w: 2, h: 1 },
    pins: [
      { id: "p1", name: "+", local: { x: -1, y: 0 } },
      { id: "p2", name: "-", local: { x: 1, y: 0 } },
    ],
    params: [
      { key: "voltage", label: "Voltage", unit: "volt", default: 5 },
    ],
    refPrefix: "V",
  },

  vsource_ac: {
    kind: "vsource_ac",
    label: "AC Voltage Source",
    symbolId: "vsource_ac",
    size: { w: 2, h: 1 },
    pins: [
      { id: "p1", name: "+", local: { x: -1, y: 0 } },
      { id: "p2", name: "-", local: { x: 1, y: 0 } },
    ],
    params: [
      { key: "amplitude", label: "Amplitude", unit: "volt", default: 5 },
      { key: "frequency", label: "Frequency", unit: "hz", default: 1000 },
    ],
    refPrefix: "V",
  },

  battery: {
    kind: "battery",
    label: "Battery",
    symbolId: "battery",
    size: { w: 2, h: 1 },
    pins: [
      { id: "p1", name: "+", local: { x: -1, y: 0 } },
      { id: "p2", name: "-", local: { x: 1, y: 0 } },
    ],
    params: [
      { key: "voltage", label: "Voltage", unit: "volt", default: 9 },
    ],
    refPrefix: "V",
  },

  // Drawn as a two-terminal diamond (that is how the model detects it); its
  // controlling expression is not captured, so it is simulated at the
  // voltage set here.
  vsource_dep: {
    kind: "vsource_dep",
    label: "Dependent Voltage Source",
    symbolId: "vsource_dep",
    size: { w: 2, h: 1 },
    pins: [
      { id: "p1", name: "A", local: { x: -1, y: 0 } },
      { id: "p2", name: "B", local: { x: 1, y: 0 } },
    ],
    params: [
      { key: "voltage", label: "Voltage", unit: "volt", default: 5 },
    ],
    refPrefix: "E",
  },

  diode: {
    kind: "diode",
    label: "Diode",
    symbolId: "diode",
    size: { w: 2, h: 1 },
    pins: [
      { id: "p1", name: "anode", local: { x: -1, y: 0 } },
      { id: "p2", name: "cathode", local: { x: 1, y: 0 } },
    ],
    params: [],
    refPrefix: "D",
  },

  // Three-pin parts. Pin order matters to the backend: pins 0 and 1 are
  // the pair the branch analysis' ΔV / current describe (collector-emitter
  // here, so ΔV = Vce and the current is Ic); every pin's own voltage and
  // current come back in pin_voltages / pin_currents.
  bjt_npn: {
    kind: "bjt_npn",
    label: "NPN Transistor",
    symbolId: "bjt_npn",
    size: { w: 2, h: 2 },
    pins: [
      { id: "p1", name: "C", local: { x: 1, y: -1 }, dir: { x: 0, y: -1 } },
      { id: "p2", name: "E", local: { x: 1, y: 1 }, dir: { x: 0, y: 1 } },
      { id: "p3", name: "B", local: { x: -1, y: 0 } },
    ],
    params: [
      { key: "beta", label: "Gain β (hFE)", unit: "none", default: 100 },
    ],
    refPrefix: "Q",
  },

  bjt_pnp: {
    kind: "bjt_pnp",
    label: "PNP Transistor",
    symbolId: "bjt_pnp",
    size: { w: 2, h: 2 },
    pins: [
      { id: "p1", name: "C", local: { x: 1, y: 1 }, dir: { x: 0, y: 1 } },
      { id: "p2", name: "E", local: { x: 1, y: -1 }, dir: { x: 0, y: -1 } },
      { id: "p3", name: "B", local: { x: -1, y: 0 } },
    ],
    params: [
      { key: "beta", label: "Gain β (hFE)", unit: "none", default: 100 },
    ],
    refPrefix: "Q",
  },

  // Ideal op-amp with output limits: the output is referenced to ground
  // and saturates at the two rail voltages (the supply pins aren't drawn).
  // ΔV is the differential input V(+) − V(−).
  opamp: {
    kind: "opamp",
    label: "Op-Amp",
    symbolId: "opamp",
    size: { w: 4, h: 2.5 },
    pins: [
      { id: "p1", name: "+", local: { x: -2, y: 1 }, dir: { x: -1, y: 0 } },
      { id: "p2", name: "−", local: { x: -2, y: -1 }, dir: { x: -1, y: 0 } },
      { id: "p3", name: "out", local: { x: 2, y: 0 } },
    ],
    params: [
      { key: "gain", label: "Open-loop gain", unit: "none", default: 1e5 },
      { key: "vpos", label: "Output max (+rail)", unit: "volt", default: 15 },
      { key: "vneg", label: "Output min (−rail)", unit: "volt", default: -15 },
    ],
    refPrefix: "U",
  },

  ground: {
    kind: "ground",
    label: "Ground",
    symbolId: "ground",
    size: { w: 1, h: 1 },
    pins: [{ id: "p1", name: "GND", local: { x: 0, y: -1 } }],
    params: [],
    refPrefix: "GND",
  },
};

export const PALETTE_ORDER: ComponentKind[] = [
  "resistor",
  "capacitor",
  "inductor",
  "vsource_dc",
  "vsource_ac",
  "battery",
  "bjt_npn",
  "bjt_pnp",
  "opamp",
  // Hidden from the palette for now; their defs stay so loaded or
  // generated circuits that contain them still work.
  // "vsource_dep",
  // "diode",
  "ground",
];

export function getDef(kind: ComponentKind): ComponentDef {
  return COMPONENT_DEFS[kind];
}

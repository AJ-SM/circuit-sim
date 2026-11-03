import type { Netlist } from "../domain/netlist";
import type { SimulationConfig } from "../domain/simulationConfig";
import type { ComponentKind } from "../types/circuit";
import { BACKEND_ORIGIN } from "./backendOrigin";

export const SOLVE_UNKNOWN_ENDPOINT = `${BACKEND_ORIGIN}/solve-unknown`;

/** Parts whose main value can be the unknown x (see backend unknown_solver.py). */
export const UNKNOWN_KINDS = new Set<ComponentKind>([
  "resistor",
  "capacitor",
  "inductor",
  "vsource_dc",
  "battery",
  "vsource_dep",
  "vsource_ac",
]);

/** "x", "X", "?", "R=x", "Rx", "xΩ": a value written as unknown. */
export function isUnknownText(text: string): boolean {
  let t = text.replace(/\s+/g, "");
  if (t.includes("=")) t = t.slice(t.lastIndexOf("=") + 1);
  return /^[RCLVrclv]?[xX?](?:[kKmMuUµμnp]?(?:Ω|ohms?|F|f|H|h|V|v))?$/.test(t);
}

export type MeasuredQuantity = "voltage" | "current" | "power";

export const QUANTITY_UNIT: Record<MeasuredQuantity, string> = {
  voltage: "V",
  current: "A",
  power: "W",
};

export interface SolveUnknownRequest {
  netlist: Netlist;
  analysis: SimulationConfig;
  unknown: { component_id: string; param?: string };
  measurement: { component_id: string; quantity: MeasuredQuantity; value: number };
}

export interface SolveUnknownResult {
  ok: boolean;
  message?: string | null;
  component_id?: string;
  ref?: string;
  param?: string;
  /** "ohm" | "F" | "H" | "V" */
  unit?: string;
  value?: number | null;
  /** Every value of x that fits, most likely first (value === solutions[0]). */
  solutions: number[];
  /** "exact" (linear circuit, closed form) or "numeric" (searched). */
  method?: string | null;
  measured_ref?: string;
  quantity?: MeasuredQuantity;
  target?: number;
  /** The measured quantity the circuit shows with x = value. */
  achieved?: number | null;
  evaluations: number;
  notes: string[];
}

export async function solveUnknown(req: SolveUnknownRequest): Promise<SolveUnknownResult> {
  let response: Response;
  try {
    response = await fetch(SOLVE_UNKNOWN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
  } catch {
    throw new Error(`Couldn't reach the backend at ${SOLVE_UNKNOWN_ENDPOINT}. Is the Python server running?`);
  }
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* keep statusText */
    }
    throw new Error(detail);
  }
  return (await response.json()) as SolveUnknownResult;
}

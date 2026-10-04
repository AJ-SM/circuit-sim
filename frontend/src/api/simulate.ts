import type { Netlist } from "../domain/netlist";
import type { SimulationConfig } from "../domain/simulationConfig";

export const SIMULATE_ENDPOINT =
  import.meta.env.VITE_SIMULATE_URL ?? "http://localhost:8000/simulate";

export interface SimulateRequest {
  netlist: Netlist;
  analysis: SimulationConfig;
}

/** Per-component branch analysis result from the backend. */
export interface BranchInfo {
  component_id: string;
  ref: string;
  type: string;
  node_a: string;
  node_b: string;
  voltage_a: number;
  voltage_b: number;
  delta_v: number;
  current_a: number;
  direction: "a_to_b" | "b_to_a" | "none";
}

export interface SimulationResult {
  ok: boolean;
  message?: string;
  /** e.g. { "time": [...], "V(1)": [...], "I(R1)": [...] } */
  traces?: Record<string, number[]>;
  /** NEW: per-component voltage, current, and direction — added alongside traces */
  branch_analysis?: BranchInfo[];
}

export async function runSimulation(
  netlist: Netlist,
  analysis: SimulationConfig
): Promise<SimulationResult> {
  const body: SimulateRequest = { netlist, analysis };

  let response: Response;
  try {
    response = await fetch(SIMULATE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      `Couldn't reach the simulation backend at ${SIMULATE_ENDPOINT}. ` +
        `Is the Python server running yet? (It hasn't been built in this step.)`
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Backend returned ${response.status}: ${text || response.statusText}`);
  }

  return (await response.json()) as SimulationResult;
}
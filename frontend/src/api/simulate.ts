import type { Netlist } from "../domain/netlist";
import type { SimulationConfig } from "../domain/simulationConfig";

/** Change this once the Python backend exists, or set VITE_SIMULATE_URL
 *  in a .env file to override it without touching code. */
export const SIMULATE_ENDPOINT =
  import.meta.env.VITE_SIMULATE_URL ?? "http://localhost:8000/simulate";

export interface SimulateRequest {
  netlist: Netlist;
  analysis: SimulationConfig;
}

/** Shape the backend is expected to return. Adjust when the real backend
 *  lands; nothing else in the UI needs to change if this stays close. */
export interface SimulationResult {
  ok: boolean;
  message?: string;
  /** e.g. { "time": [...], "V(1)": [...], "I(R1)": [...] } */
  traces?: Record<string, number[]>;
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

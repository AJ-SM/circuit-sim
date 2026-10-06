import { useEffect, useRef, useState } from "react";
import { useCircuitStore } from "../store/circuitStore";

/** Keep the running (green) state on screen at least this long, so a fast
 *  simulation still visibly flashes green instead of flickering. */
const MIN_RUNNING_MS = 500;

/** The toolbar's Run Simulation button: blue when idle, green while running. */
export function RunSimulationButton() {
  const components = useCircuitStore((s) => s.components);
  const simStatus = useCircuitStore((s) => s.simStatus);
  const runSimulate = useCircuitStore((s) => s.runSimulate);

  // A hidden default ground is added by buildNetlist when none is drawn.
  const canSimulate = components.some((c) => c.kind !== "ground");

  const [showRunning, setShowRunning] = useState(false);
  const startedAt = useRef(0);
  useEffect(() => {
    if (simStatus === "running") {
      startedAt.current = Date.now();
      setShowRunning(true);
      return;
    }
    const left = MIN_RUNNING_MS - (Date.now() - startedAt.current);
    if (left <= 0) {
      setShowRunning(false);
      return;
    }
    const t = window.setTimeout(() => setShowRunning(false), left);
    return () => window.clearTimeout(t);
  }, [simStatus]);

  const running = showRunning || simStatus === "running";

  return (
    <button
      className={`btn btn-load btn-run${running ? " running" : ""}`}
      disabled={!canSimulate}
      aria-busy={running}
      title={canSimulate ? "Run the simulation" : "Place at least one component to simulate"}
      onClick={() => {
        if (!running) runSimulate();
      }}
    >
      {running ? (
        <>
          <span className="run-spinner" aria-hidden="true" /> Simulating…
        </>
      ) : (
        "▶ Run Simulation"
      )}
    </button>
  );
}

import { useCircuitStore } from "../store/circuitStore";
import type { BranchInfo } from "../api/simulate";

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtAmps(a: number): string {
  const abs = Math.abs(a);
  if (abs === 0) return "0 A";
  if (abs >= 1) return `${a.toFixed(3)} A`;
  if (abs >= 1e-3) return `${(a * 1e3).toFixed(3)} mA`;
  if (abs >= 1e-6) return `${(a * 1e6).toFixed(3)} µA`;
  if (abs >= 1e-9) return `${(a * 1e9).toFixed(3)} nA`;
  return `${a.toExponential(2)} A`;
}

function fmtVolts(v: number): string {
  const abs = Math.abs(v);
  if (abs < 0.001) return "0.00 V";
  if (abs >= 1) return `${v.toFixed(3)} V`;
  return `${(v * 1e3).toFixed(1)} mV`;
}

/** Current cell colour: the current colour, grey when no current flows */
function currentColor(a: number): string {
  return Math.abs(a) < 1e-15 ? "var(--text-faint)" : "var(--sim-current)";
}

/** Direction indicator with arrow */
function DirectionCell({ b }: { b: BranchInfo }) {
  if (b.direction === "none" || Math.abs(b.current_a) < 1e-15) {
    return <span style={{ color: "var(--text-faint)" }}>—</span>;
  }
  const from = b.direction === "a_to_b" ? b.node_a : b.node_b;
  const to = b.direction === "a_to_b" ? b.node_b : b.node_a;
  return (
    <span style={{ color: "var(--sim-current)", display: "flex", alignItems: "center", gap: 4, fontFamily: "var(--font-label)" }}>
      <span style={{ color: "#94a3b8", fontSize: 10 }}>{from}</span>
      <span style={{ color: "var(--sim-current)", fontSize: 12 }}>→</span>
      <span style={{ color: "#94a3b8", fontSize: 10 }}>{to}</span>
    </span>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

/** Sidebar tab: per-component voltage, current and direction from the last
 *  simulation. Clicking a row selects the part and toggles its canvas badge. */
export function BranchAnalysisPanel() {
  const simStatus = useCircuitStore((s) => s.simStatus);
  const simResult = useCircuitStore((s) => s.simResult);
  const toggleComponentBadge = useCircuitStore((s) => s.toggleComponentBadge);
  const select = useCircuitStore((s) => s.select);

  const branches = simStatus === "done" ? simResult?.branch_analysis ?? [] : [];

  if (branches.length === 0) {
    return (
      <div className="panel-section branch-tab">
        <p className="hint-text">
          {simStatus === "running"
            ? "Simulating…"
            : "Run a simulation from the Inspector tab to see the voltage, current and direction for every component here."}
        </p>
      </div>
    );
  }

  return (
    <div className="panel-section panel-section-grow branch-tab">
      {simResult?.message && <p className="hint-text">{simResult.message}</p>}
      <p className="hint-text">Click a row to select the part and show its values on the canvas.</p>
      <div className="branch-scroll">
        <table className="branch-table">
          <thead>
            <tr>
              <th>Ref</th>
              <th>ΔV</th>
              <th>Current</th>
              <th>Direction</th>
            </tr>
          </thead>
          <tbody>
            {branches.map((b) => {
              const iColor = currentColor(b.current_a);

              return (
                <tr
                  key={b.component_id}
                  style={{ cursor: "pointer" }}
                  onClick={() => {
                    select({ type: "component", id: b.component_id });
                    toggleComponentBadge(b.component_id);
                  }}
                  title="Click to toggle measurements on canvas"
                >
                  <td>
                    <span style={{ fontWeight: 700, color: "#f1f5f9", fontFamily: "var(--font-label)", fontSize: 11 }}>
                      {b.ref}
                    </span>
                    <span style={{ color: "#475569", fontSize: 9, display: "block" }}>
                      {b.type}
                    </span>
                  </td>
                  <td className="val-v" style={{ fontSize: 11 }}>
                    {fmtVolts(b.delta_v)}
                  </td>
                  <td style={{ fontFamily: "var(--font-label)", fontSize: 11, color: iColor }}>
                    {fmtAmps(b.current_a)}
                  </td>
                  <td>
                    <DirectionCell b={b} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

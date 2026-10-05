import { useMemo, useState } from "react";
import { useCircuitStore } from "../store/circuitStore";
import { buildNetlist } from "../domain/netlist";
import type { AnalysisMode } from "../domain/simulationConfig";
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

/** Current magnitude → color intensity for the current cell */
function currentColor(a: number, maxA: number): string {
  if (maxA === 0 || Math.abs(a) < 1e-15) return "#475569";
  const t = Math.min(1, Math.abs(a) / maxA);
  // faint green → bright phosphor
  const r = Math.round(74 + t * (110 - 74));
  const g = Math.round(222 + t * (255 - 222));
  const b = Math.round(128 + t * (176 - 128));
  return `rgb(${r},${g},${b})`;
}

/** Direction indicator with arrow */
function DirectionCell({ b }: { b: BranchInfo }) {
  if (b.direction === "none" || Math.abs(b.current_a) < 1e-15) {
    return <span style={{ color: "#475569" }}>—</span>;
  }
  const from = b.direction === "a_to_b" ? b.node_a : b.node_b;
  const to = b.direction === "a_to_b" ? b.node_b : b.node_a;
  return (
    <span style={{ color: "#fbbf24", display: "flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono)" }}>
      <span style={{ color: "#94a3b8", fontSize: 10 }}>{from}</span>
      <span style={{ color: "#fbbf24", fontSize: 12 }}>→</span>
      <span style={{ color: "#94a3b8", fontSize: 10 }}>{to}</span>
    </span>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SimulationPanel() {
  const components = useCircuitStore((s) => s.components);
  const wires = useCircuitStore((s) => s.wires);
  const simConfig = useCircuitStore((s) => s.simConfig);
  const setSimConfig = useCircuitStore((s) => s.setSimConfig);
  const simStatus = useCircuitStore((s) => s.simStatus);
  const simResult = useCircuitStore((s) => s.simResult);
  const simError = useCircuitStore((s) => s.simError);
  const runSimulate = useCircuitStore((s) => s.runSimulate);
  const showAllBadges = useCircuitStore((s) => s.showAllBadges);
  const setShowAllBadges = useCircuitStore((s) => s.setShowAllBadges);
  const toggleComponentBadge = useCircuitStore((s) => s.toggleComponentBadge);
  const select = useCircuitStore((s) => s.select);

  const [showPayload, setShowPayload] = useState(false);

  const netlist = useMemo(() => buildNetlist(components, wires), [components, wires]);

  const groundCount = components.filter((c) => c.kind === "ground").length;
  const canSimulate = components.length > 0 && groundCount > 0;

  const branches = simResult?.branch_analysis ?? [];

  const maxCurrent = useMemo(
    () => branches.reduce((m, b) => Math.max(m, Math.abs(b.current_a)), 0),
    [branches]
  );

  // Max signed voltage — GND is 0, so scale from 0 → highest +V node
  const maxVoltage = useMemo(
    () => branches.reduce((m, b) => Math.max(m, b.voltage_a, b.voltage_b), 0),
    [branches]
  );

  // Node voltage summary — unique nodes from branch analysis
  const nodeVoltages = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of branches) {
      map.set(b.node_a, Math.abs(b.voltage_a) < 0.001 ? 0 : b.voltage_a);
      map.set(b.node_b, Math.abs(b.voltage_b) < 0.001 ? 0 : b.voltage_b);
    }
    map.set("0", 0);
    return Array.from(map.entries()).sort((a, b) =>
      a[0] === "0" ? -1 : b[0] === "0" ? 1 : a[0].localeCompare(b[0])
    );
  }, [branches]);

  return (
    <div className="panel-section panel-section-grow">
      <div className="panel-title">Analysis</div>

      <label className="field">
        <span className="field-label">Type</span>
        <select
          className="field-input"
          value={simConfig.mode}
          onChange={(e) =>
            setSimConfig({ ...simConfig, mode: e.target.value as AnalysisMode })
          }
        >
          <option value="tran">Transient</option>
          <option value="dc">DC Operating Point</option>
          <option value="ac">AC Sweep</option>
        </select>
      </label>

      {simConfig.mode === "tran" && (
        <>
          <label className="field">
            <span className="field-label">Step (s)</span>
            <input
              className="field-input"
              value={simConfig.tran.stepSeconds}
              onChange={(e) =>
                setSimConfig({
                  ...simConfig,
                  tran: { ...simConfig.tran, stepSeconds: Number(e.target.value) || 0 },
                })
              }
            />
          </label>
          <label className="field">
            <span className="field-label">Stop (s)</span>
            <input
              className="field-input"
              value={simConfig.tran.stopSeconds}
              onChange={(e) =>
                setSimConfig({
                  ...simConfig,
                  tran: { ...simConfig.tran, stopSeconds: Number(e.target.value) || 0 },
                })
              }
            />
          </label>
        </>
      )}

      {simConfig.mode === "ac" && (
        <>
          <label className="field">
            <span className="field-label">Start (Hz)</span>
            <input
              className="field-input"
              value={simConfig.ac.startHz}
              onChange={(e) =>
                setSimConfig({ ...simConfig, ac: { ...simConfig.ac, startHz: Number(e.target.value) || 0 } })
              }
            />
          </label>
          <label className="field">
            <span className="field-label">Stop (Hz)</span>
            <input
              className="field-input"
              value={simConfig.ac.stopHz}
              onChange={(e) =>
                setSimConfig({ ...simConfig, ac: { ...simConfig.ac, stopHz: Number(e.target.value) || 0 } })
              }
            />
          </label>
        </>
      )}

      {!canSimulate && (
        <p className="hint-text warn">
          {components.length === 0
            ? "Place at least one component to simulate."
            : "Add a ground reference — every circuit needs one node tied to 0V."}
        </p>
      )}

      <button
        className="btn btn-primary"
        disabled={!canSimulate || simStatus === "running"}
        onClick={runSimulate}
      >
        {simStatus === "running" ? "Simulating…" : "▶ Run Simulation"}
      </button>

      <button className="btn-link" onClick={() => setShowPayload((v) => !v)}>
        {showPayload ? "Hide" : "Show"} request JSON
      </button>

      {showPayload && (
        <pre className="json-preview">
          {JSON.stringify({ netlist, analysis: simConfig }, null, 2)}
        </pre>
      )}

      {simStatus === "error" && <div className="result-box result-error">{simError}</div>}

      {simStatus === "done" && simResult && (
        <>
          <div className="result-box result-ok" style={{ fontSize: 11, padding: "6px 10px" }}>
            {simResult.message ?? "✓ Simulation complete"}
          </div>
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            margin: "8px 0 4px",
            padding: "4px 8px",
            background: "rgba(255,255,255,0.03)",
            borderRadius: 4,
            border: "1px solid rgba(255,255,255,0.06)",
          }}>
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
              {showAllBadges ? "All labels visible" : "Click components to inspect"}
            </span>
            <button
              className="btn btn-xs"
              onClick={() => setShowAllBadges(!showAllBadges)}
              style={{ fontSize: 10, padding: "2px 8px" }}
              title="Toggle showing measurements on all components at once"
            >
              {showAllBadges ? "Hide Values" : "Show All Values"}
            </button>
          </div>
        </>
      )}

      {/* ── Node Voltages Summary ── */}
      {nodeVoltages.length > 0 && (
        <div className="sim-section">
          <div className="sim-section-title">Node Voltages</div>
          <div className="node-voltage-grid">
            {nodeVoltages.map(([node, v]) => (
              <div key={node} className="node-voltage-item">
                <span className="node-id">{node === "0" ? "GND" : `N${node}`}</span>
                <span
                  className="node-v"
                  style={{
                    // EE color convention: blue=GND, green=mid, amber/red=high potential
                    color: (() => {
                      if (node === "0" || (maxVoltage > 0 && v / maxVoltage < 0.08)) return "#38bdf8";
                      if (maxVoltage === 0) return "#6effb0";
                      const t = Math.min(1, Math.max(0, v / maxVoltage));
                      if (t < 0.5)  return "#6effb0";
                      if (t < 0.85) return "#ffb454";
                      return "#f87171";
                    })(),
                  }}
                >
                  {fmtVolts(v)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Branch Analysis Table ── */}
      {branches.length > 0 && (
        <div className="sim-section">
          <div className="sim-section-title">Branch Analysis</div>
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
                  const iMag = Math.abs(b.current_a);
                  const iColor = currentColor(b.current_a, maxCurrent);
                  const rowHighlight =
                    iMag > 0
                      ? `rgba(${Math.round(iMag / maxCurrent * 110)}, ${Math.round(iMag / maxCurrent * 255)}, ${Math.round(iMag / maxCurrent * 176)}, 0.04)`
                      : "transparent";

                  return (
                    <tr
                      key={b.component_id}
                      style={{ background: rowHighlight, cursor: "pointer" }}
                      onClick={() => {
                        select({ type: "component", id: b.component_id });
                        toggleComponentBadge(b.component_id);
                      }}
                      title="Click to toggle measurements on canvas"
                    >
                      <td>
                        <span style={{ fontWeight: 700, color: "#f1f5f9", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                          {b.ref}
                        </span>
                        <span style={{ color: "#475569", fontSize: 9, display: "block" }}>
                          {b.type}
                        </span>
                      </td>
                      <td className="val-v" style={{ fontSize: 11 }}>
                        {fmtVolts(b.delta_v)}
                      </td>
                      <td style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: iColor }}>
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
      )}
    </div>
  );
}

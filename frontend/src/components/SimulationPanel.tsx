import { useMemo, useState } from "react";
import { useCircuitStore } from "../store/circuitStore";
import { PanelSection } from "./PanelSection";
import { buildNetlist } from "../domain/netlist";
import type { AnalysisMode } from "../domain/simulationConfig";

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtVolts(v: number): string {
  const abs = Math.abs(v);
  if (abs < 0.001) return "0.00 V";
  if (abs >= 1) return `${v.toFixed(3)} V`;
  return `${(v * 1e3).toFixed(1)} mV`;
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
  const showAllBadges = useCircuitStore((s) => s.showAllBadges);
  const setShowAllBadges = useCircuitStore((s) => s.setShowAllBadges);

  const [showPayload, setShowPayload] = useState(false);

  const netlist = useMemo(() => buildNetlist(components, wires), [components, wires]);


  const branches = simResult?.branch_analysis ?? [];


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
    <PanelSection id="analysis" title="Analysis" grow>

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
              {showAllBadges ? "All labels visible" : "Turn on the eye, then click a part to see its values"}
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
                  style={{ color: "var(--sim-voltage)" }}
                >
                  {fmtVolts(v)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

    </PanelSection>
  );
}

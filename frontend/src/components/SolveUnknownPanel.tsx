import { useState } from "react";
import { useCircuitStore } from "../store/circuitStore";
import { PanelSection } from "./PanelSection";
import { buildNetlist } from "../domain/netlist";
import { getDef } from "../domain/componentDefs";
import { formatMeasurement, formatSIValue } from "../utils/units";
import type { ParamUnit } from "../types/circuit";
import { UNKNOWN_KINDS, solveUnknown, type SolveUnknownResult } from "../api/solveUnknown";

const BACKEND_UNIT: Record<string, ParamUnit> = { ohm: "ohm", F: "farad", H: "henry", V: "volt" };

/** One button: find x from the circuit's values and the known measurement
 *  read from the drawing. The answer is written onto the part as "x = …". */
export function SolveUnknownPanel() {
  const components = useCircuitStore((s) => s.components);
  const simConfig = useCircuitStore((s) => s.simConfig);
  const applySolvedValue = useCircuitStore((s) => s.applySolvedValue);

  const [status, setStatus] = useState<"idle" | "solving" | "done" | "error">("idle");
  const [result, setResult] = useState<SolveUnknownResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const unknowns = components.filter((c) => c.unknown && UNKNOWN_KINDS.has(c.kind));
  const givens = components.filter((c) => c.measured && c.kind !== "ground");
  const unknown = unknowns[0];

  if (!unknown) {
    return (
      <PanelSection id="solve-unknown" title="Solve for x">
        <p className="hint-text">
          No unknown found. Write <b>x</b> next to a part in the drawing, or type <b>x</b> as its value.
        </p>
      </PanelSection>
    );
  }

  const unit: ParamUnit = getDef(unknown.kind).params[0]?.unit ?? "none";

  async function onSolve() {
    if (!unknown) return;
    setStatus("solving");
    setError(null);
    setResult(null);
    const { components: comps, wires } = useCircuitStore.getState();
    const netlist = buildNetlist(comps, wires);
    // Use the first given that determines x; a later one is tried only when
    // an earlier one doesn't depend on x (e.g. the voltage of a source).
    let last: string | null = null;
    try {
      for (const g of givens) {
        const r = await solveUnknown({
          netlist,
          analysis: simConfig,
          unknown: { component_id: unknown.id },
          measurement: { component_id: g.id, quantity: g.measured!.quantity, value: g.measured!.value },
        });
        if (r.ok && r.value != null) {
          setResult(r);
          setStatus("done");
          await applySolvedValue(unknown.id, r.value);
          return;
        }
        last = r.message ?? "No solution found.";
      }
      setError(last);
      setStatus("error");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  const resultUnit: ParamUnit = (result?.unit && BACKEND_UNIT[result.unit]) || unit;

  return (
    <PanelSection id="solve-unknown" title="Solve for x">
      <div className="solve-summary">
        <div className="solve-row">
          <span className="solve-key">Unknown</span>
          <span>
            <b>{unknown.refId}</b> = x
          </span>
        </div>
        <div className="solve-row">
          <span className="solve-key">Given</span>
          {givens.length > 0 ? (
            <span>
              {givens.map((g) => (
                <span key={g.id} className="solve-given-item">
                  {formatMeasurement(g.measured!)} on <b>{g.refId}</b>
                </span>
              ))}
            </span>
          ) : (
            <span className="solve-missing">none found</span>
          )}
        </div>
      </div>

      {unknowns.length > 1 && (
        <p className="hint-text warn">
          Only one x can be solved at a time; solving {unknown.refId}.
        </p>
      )}
      {givens.length === 0 && (
        <p className="hint-text warn">
          No known voltage or current was read. Write one next to a part in the drawing (e.g.{" "}
          <b>8V</b> or <b>I = 2mA</b>), or enter it in that part's <i>Known value</i>.
        </p>
      )}

      <button
        className="btn btn-primary"
        disabled={givens.length === 0 || status === "solving"}
        onClick={() => void onSolve()}
      >
        {status === "solving" ? "Solving…" : "Solve for x"}
      </button>

      {status === "error" && error && <div className="result-box result-error">{error}</div>}

      {status === "done" && result?.value != null && (
        <div className="result-box result-ok solve-result">
          <div className="solve-answer">
            <span className="solve-answer-name">{result.ref} = x =</span>{" "}
            <span className="solve-answer-value">{formatSIValue(result.value, resultUnit)}</span>
          </div>
          {result.solutions.length > 1 && (
            <div className="solve-alts">
              <span>Also fits:</span>
              <div className="solve-alt-row">
                {result.solutions.slice(1).map((x) => (
                  <button
                    key={x}
                    className="btn btn-xs"
                    onClick={() => {
                      setResult({ ...result, value: x, solutions: [x, ...result.solutions.filter((s) => s !== x)] });
                      void applySolvedValue(unknown.id, x);
                    }}
                  >
                    {formatSIValue(x, resultUnit)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </PanelSection>
  );
}

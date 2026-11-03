import { useMemo, useState } from "react";
import { useCircuitStore } from "../store/circuitStore";
import { PanelSection } from "./PanelSection";
import { buildNetlist } from "../domain/netlist";
import { getDef } from "../domain/componentDefs";
import { formatSIValue, parseSIValue } from "../utils/units";
import type { ParamUnit } from "../types/circuit";
import {
  QUANTITY_UNIT,
  UNKNOWN_KINDS,
  solveUnknown,
  type MeasuredQuantity,
  type SolveUnknownResult,
} from "../api/solveUnknown";

const SOURCE_KINDS = new Set(["vsource_dc", "vsource_ac", "battery", "vsource_dep"]);

const BACKEND_UNIT: Record<string, ParamUnit> = { ohm: "ohm", F: "farad", H: "henry", V: "volt" };

const QUANTITY_LABEL: Record<MeasuredQuantity, string> = {
  voltage: "Voltage across",
  current: "Current through",
  power: "Power in",
};

/** "8V", "2 mA", "0.5W", "4.7m" -> SI number. */
function parseMeasured(text: string): number | null {
  const stripped = text.trim().replace(/\s*(volts?|amps?|watts?|[VAW])$/i, "");
  return parseSIValue(stripped);
}

function fmtQuantity(v: number, q: MeasuredQuantity): string {
  return `${formatSIValue(v, "none")}${QUANTITY_UNIT[q]}`;
}

/** Find the unknown value x of one part from one known measurement. */
export function SolveUnknownPanel() {
  const components = useCircuitStore((s) => s.components);
  const wires = useCircuitStore((s) => s.wires);
  const simConfig = useCircuitStore((s) => s.simConfig);
  const applySolvedValue = useCircuitStore((s) => s.applySolvedValue);
  const select = useCircuitStore((s) => s.select);

  const unknowns = components.filter((c) => c.unknown && UNKNOWN_KINDS.has(c.kind));
  const parts = components.filter((c) => c.kind !== "ground");

  const [unknownId, setUnknownId] = useState<string | null>(null);
  const [measuredId, setMeasuredId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState<MeasuredQuantity>("voltage");
  const [valueText, setValueText] = useState("");
  const [status, setStatus] = useState<"idle" | "solving" | "done" | "error">("idle");
  const [result, setResult] = useState<SolveUnknownResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);

  // Fall back to sensible picks when the circuit changes under the panel.
  const unknown = unknowns.find((c) => c.id === unknownId) ?? unknowns[0] ?? null;
  const measured =
    parts.find((c) => c.id === measuredId) ??
    // A source's own voltage never depends on x, so default to a passive part.
    parts.find((c) => c.id !== unknown?.id && !c.unknown && !SOURCE_KINDS.has(c.kind)) ??
    parts.find((c) => c.id !== unknown?.id && !c.unknown) ??
    parts[0] ??
    null;

  const netlist = useMemo(() => buildNetlist(components, wires), [components, wires]);
  const target = parseMeasured(valueText);

  if (unknowns.length === 0) {
    return (
      <PanelSection id="solve-unknown" title="Solve for x">
        <p className="hint-text">
          To find an unknown value, select the part and type <b>x</b> as its value (or use{" "}
          <i>Mark value as unknown</i>). In a drawing, write <b>x</b> or <b>?</b> next to the part.
        </p>
      </PanelSection>
    );
  }

  const unknownDef = unknown ? getDef(unknown.kind) : null;
  const unknownParam = unknownDef?.params[0];

  async function onSolve() {
    if (!unknown || !measured || target === null) return;
    setStatus("solving");
    setError(null);
    setResult(null);
    setChosen(null);
    try {
      const r = await solveUnknown({
        netlist,
        analysis: simConfig,
        unknown: { component_id: unknown.id },
        measurement: { component_id: measured.id, quantity, value: target },
      });
      setResult(r);
      if (r.ok && r.value != null) {
        setChosen(r.value);
        setStatus("done");
      } else {
        setError(r.message ?? "No solution found.");
        setStatus("error");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  const resultUnit: ParamUnit = (result?.unit && BACKEND_UNIT[result.unit]) || unknownParam?.unit || "none";
  const resultFor = result?.component_id ? components.find((c) => c.id === result.component_id) : null;

  return (
    <PanelSection
      id="solve-unknown"
      title={<>Solve for x <span className="ref-badge">{unknowns.map((u) => u.refId).join(", ")}</span></>}
    >
      {unknowns.length > 1 && (
        <>
          <label className="field">
            <span className="field-label">Unknown x</span>
            <select
              className="field-input"
              value={unknown?.id ?? ""}
              onChange={(e) => setUnknownId(e.target.value)}
            >
              {unknowns.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.refId} ({getDef(u.kind).params[0]?.label.toLowerCase()})
                </option>
              ))}
            </select>
          </label>
          <p className="hint-text warn">
            One measurement finds one unknown. The other unknowns keep their current number while
            this one is solved.
          </p>
        </>
      )}

      <div className="solve-given">Given</div>
      <label className="field">
        <span className="field-label">Quantity</span>
        <select
          className="field-input"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value as MeasuredQuantity)}
        >
          {(Object.keys(QUANTITY_LABEL) as MeasuredQuantity[]).map((q) => (
            <option key={q} value={q}>
              {QUANTITY_LABEL[q]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Part</span>
        <select
          className="field-input"
          value={measured?.id ?? ""}
          onChange={(e) => setMeasuredId(e.target.value)}
        >
          {parts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.refId}
              {c.unknown ? " (x)" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Value</span>
        <input
          className={
            valueText.trim() && target === null ? "field-input field-input-invalid" : "field-input"
          }
          value={valueText}
          placeholder={quantity === "voltage" ? "e.g. 8V" : quantity === "current" ? "e.g. 2mA" : "e.g. 0.5W"}
          onChange={(e) => setValueText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onSolve();
          }}
        />
      </label>

      <button
        className="btn btn-primary"
        disabled={!unknown || !measured || target === null || status === "solving"}
        onClick={() => void onSolve()}
      >
        {status === "solving" ? "Solving…" : `Find ${unknown?.refId ?? "x"}`}
      </button>

      {status === "error" && error && <div className="result-box result-error">{error}</div>}

      {status === "done" && result && chosen != null && (
        <div className="result-box result-ok solve-result">
          <div className="solve-answer">
            <span className="solve-answer-name">
              {result.ref} = x =
            </span>{" "}
            <span className="solve-answer-value">{formatSIValue(chosen, resultUnit)}</span>
          </div>
          {result.achieved != null && result.quantity && (
            <div className="solve-check">
              Check: {QUANTITY_LABEL[result.quantity].toLowerCase()} {result.measured_ref} ={" "}
              {fmtQuantity(Math.abs(result.achieved), result.quantity)} ✓
            </div>
          )}
          <div className="solve-meta">
            {result.method === "exact"
              ? `Exact solution (linear circuit, ${result.evaluations} circuit solves)`
              : `Numeric search (${result.evaluations} circuit solves)`}
          </div>
          {result.solutions.length > 1 && (
            <div className="solve-alts">
              <span>{result.notes[0] ?? "Other values also fit:"}</span>
              <div className="solve-alt-row">
                {result.solutions.map((x) => (
                  <button
                    key={x}
                    className={`btn btn-xs${x === chosen ? " active" : ""}`}
                    onClick={() => setChosen(x)}
                  >
                    {formatSIValue(x, resultUnit)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {resultFor && (
            <button
              className="btn"
              onClick={() => {
                select({ type: "component", id: resultFor.id });
                void applySolvedValue(resultFor.id, chosen);
              }}
            >
              Use {formatSIValue(chosen, resultUnit)} for {result.ref} and simulate
            </button>
          )}
        </div>
      )}
    </PanelSection>
  );
}

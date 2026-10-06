import { useCircuitStore } from "../store/circuitStore";

/** Toolbar eye: while on, clicking any simulated part shows / hides its
 *  voltage and current on the canvas. */
export function InspectToggle() {
  const inspectMode = useCircuitStore((s) => s.inspectMode);
  const setInspectMode = useCircuitStore((s) => s.setInspectMode);

  return (
    <button
      className={`btn btn-load btn-eye${inspectMode ? " active" : ""}`}
      aria-pressed={inspectMode}
      onClick={() => setInspectMode(!inspectMode)}
      title={
        inspectMode
          ? "Inspect on: click a part to show or hide its voltage and current"
          : "Inspect: turn on, then click a part to see its voltage and current"
      }
    >
      <svg width="16" height="16" viewBox="-8 -8 16 16" aria-hidden="true">
        <path d="M-7 0 C-4.5 -4.6 4.5 -4.6 7 0 C4.5 4.6 -4.5 4.6 -7 0 Z"
          fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <circle r="2.2" fill="currentColor" />
        {!inspectMode && (
          <line x1="-6" y1="5.5" x2="6" y2="-5.5" stroke="currentColor" strokeWidth="1.4"
            strokeLinecap="round" />
        )}
      </svg>
      Inspect
    </button>
  );
}

import { PanelSection } from "./PanelSection";
import { useCircuitStore, type DisplayOptions, type WireLabelMode } from "../store/circuitStore";

const WIRE_LABEL_MODES: { mode: WireLabelMode; label: string }[] = [
  { mode: "off", label: "Off" },
  { mode: "current", label: "I" },
  { mode: "voltage", label: "V" },
  { mode: "both", label: "Both" },
];

function Toggle({
  label,
  hint,
  swatch,
  checked,
  onChange,
}: {
  label: string;
  /** Colour key for what the toggle draws. */
  swatch?: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="display-toggle" title={hint}>
      <span className="display-toggle-label">
        {swatch && <span className="display-swatch" style={{ background: swatch }} />}
        {label}
      </span>
      <input
        type="checkbox"
        className="display-switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

/** Show/hide the overlays the canvas draws for a simulated circuit. */
export function DisplayPanel() {
  const display = useCircuitStore((s) => s.display);
  const setDisplay = useCircuitStore((s) => s.setDisplay);
  const set = (patch: Partial<DisplayOptions>) => setDisplay(patch);

  return (
    <PanelSection id="display" title="Display">

      <Toggle
        label="Wire current direction"
        hint="Arrows and moving dashes along wires, in the direction current flows"
        swatch="var(--sim-current)"
        checked={display.currentDirection}
        onChange={(v) => set({ currentDirection: v })}
      />
      <Toggle
        label="Wire voltage direction"
        hint="Arrows on the wires next to each part: into its + end, out of its − end"
        swatch="var(--sim-voltage)"
        checked={display.voltageDirection}
        onChange={(v) => set({ voltageDirection: v })}
      />

      <div className="display-toggle">
        <span className="display-toggle-label">Wire labels</span>
        <div className="view-toggle" role="group" aria-label="Wire labels">
          {WIRE_LABEL_MODES.map(({ mode, label }) => (
            <button
              key={mode}
              className={`view-toggle-btn${display.wireLabels === mode ? " active" : ""}`}
              aria-pressed={display.wireLabels === mode}
              title={
                mode === "off" ? "No wire labels"
                  : mode === "current" ? "Current on each wire"
                  : mode === "voltage" ? "Voltage on each wire"
                  : "Current and voltage on each wire"
              }
              onClick={() => set({ wireLabels: mode })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <Toggle
        label="Component labels"
        hint="Reference (R1) and value (1kΩ) next to each part"
        checked={display.componentLabels}
        onChange={(v) => set({ componentLabels: v })}
      />
    </PanelSection>
  );
}

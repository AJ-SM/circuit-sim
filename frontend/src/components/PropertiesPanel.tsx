import { useState } from "react";
import { useCircuitStore } from "../store/circuitStore";
import { getDef } from "../domain/componentDefs";
import { PanelSection } from "./PanelSection";
import { formatSIValue, parseSIValue } from "../utils/units";
import { UNKNOWN_KINDS, isUnknownText } from "../api/solveUnknown";

export function PropertiesPanel() {
  const selection = useCircuitStore((s) => s.selection);
  const components = useCircuitStore((s) => s.components);
  const updateParam = useCircuitStore((s) => s.updateParam);
  const rotateComponent = useCircuitStore((s) => s.rotateComponent);
  const mirrorComponent = useCircuitStore((s) => s.mirrorComponent);
  const deleteSelected = useCircuitStore((s) => s.deleteSelected);
  const setUnknown = useCircuitStore((s) => s.setUnknown);

  if (selection?.type !== "component") {
    return (
      <PanelSection id="properties" title="Properties">
        <p className="hint-text">
          Select a component to edit its value, or a wire to delete it.
          Drag from the pin edge of a part to draw a connection.
        </p>
      </PanelSection>
    );
  }

  const component = components.find((c) => c.id === selection.id);
  if (!component) return null;
  const def = getDef(component.kind);

  return (
    <PanelSection
      id="properties"
      title={<>{def.label} <span className="ref-badge">{component.refId}</span></>}
    >

      {def.params.map((p, i) => {
        const value = component.params[p.key] ?? p.default;
        // Only the main value can be the unknown x (not a frequency or β).
        const canBeX = i === 0 && UNKNOWN_KINDS.has(component.kind);
        const isX = canBeX && !!component.unknown;
        return (
          <ParamField
            // Remount when the value changes elsewhere (solved x, toggled).
            key={`${component.id}-${p.key}-${isX}-${value}`}
            label={p.label}
            unit={p.unit}
            value={value}
            unknown={isX}
            onCommit={(v) => updateParam(component.id, p.key, v)}
            onUnknown={canBeX ? () => setUnknown(component.id, true) : undefined}
          />
        );
      })}

      {UNKNOWN_KINDS.has(component.kind) && (
        <button
          className="btn"
          onClick={() => setUnknown(component.id, !component.unknown)}
          title="An unknown value is solved for in the Solve for x section"
        >
          {component.unknown ? "Value is known (clear x)" : "Mark value as unknown (x)"}
        </button>
      )}

      <div className="button-row">
        <button className="btn" onClick={() => rotateComponent(component.id)}>
          Rotate (R)
        </button>
        <button className="btn" onClick={() => rotateComponent(component.id, 45)}>
          Rotate 45° (Shift+R)
        </button>
        <button className="btn" onClick={() => mirrorComponent(component.id)}>
          Mirror (M)
        </button>
      </div>
      <button className="btn btn-danger" onClick={deleteSelected}>
        Delete
      </button>
    </PanelSection>
  );
}

function ParamField({
  label,
  unit,
  value,
  unknown = false,
  onCommit,
  onUnknown,
}: {
  label: string;
  unit: Parameters<typeof formatSIValue>[1];
  value: number;
  /** Show "x" instead of the placeholder number. */
  unknown?: boolean;
  onCommit: (v: number) => void;
  /** Given when this field may be the unknown: typing "x" or "?" calls it. */
  onUnknown?: () => void;
}) {
  const [text, setText] = useState(unknown ? "x" : formatSIValue(value, unit));
  const [invalid, setInvalid] = useState(false);

  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        className={
          invalid ? "field-input field-input-invalid" : unknown ? "field-input field-input-unknown" : "field-input"
        }
        value={text}
        placeholder={onUnknown ? "value, or x if unknown" : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (onUnknown && isUnknownText(text)) {
            setInvalid(false);
            if (!unknown) onUnknown();
            setText("x");
            return;
          }
          const parsed = parseSIValue(text);
          if (parsed === null) {
            setInvalid(true);
            return;
          }
          setInvalid(false);
          onCommit(parsed);
          setText(formatSIValue(parsed, unit));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

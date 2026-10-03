import { useState } from "react";
import { useCircuitStore } from "../store/circuitStore";
import { getDef } from "../domain/componentDefs";
import { formatSIValue, parseSIValue } from "../utils/units";

export function PropertiesPanel() {
  const selection = useCircuitStore((s) => s.selection);
  const components = useCircuitStore((s) => s.components);
  const updateParam = useCircuitStore((s) => s.updateParam);
  const rotateComponent = useCircuitStore((s) => s.rotateComponent);
  const mirrorComponent = useCircuitStore((s) => s.mirrorComponent);
  const deleteSelected = useCircuitStore((s) => s.deleteSelected);

  if (selection?.type !== "component") {
    return (
      <div className="panel-section">
        <div className="panel-title">Properties</div>
        <p className="hint-text">
          Select a component to edit its value, or a wire to delete it.
          Drag from the pin edge of a part to draw a connection.
        </p>
      </div>
    );
  }

  const component = components.find((c) => c.id === selection.id);
  if (!component) return null;
  const def = getDef(component.kind);

  return (
    <div className="panel-section">
      <div className="panel-title">
        {def.label} <span className="ref-badge">{component.refId}</span>
      </div>

      {def.params.map((p) => (
        <ParamField
          key={`${component.id}-${p.key}`}
          label={p.label}
          unit={p.unit}
          value={component.params[p.key] ?? p.default}
          onCommit={(v) => updateParam(component.id, p.key, v)}
        />
      ))}

      <div className="button-row">
        <button className="btn" onClick={() => rotateComponent(component.id)}>
          Rotate (R)
        </button>
        <button className="btn" onClick={() => mirrorComponent(component.id)}>
          Mirror (M)
        </button>
      </div>
      <button className="btn btn-danger" onClick={deleteSelected}>
        Delete
      </button>
    </div>
  );
}

function ParamField({
  label,
  unit,
  value,
  onCommit,
}: {
  label: string;
  unit: Parameters<typeof formatSIValue>[1];
  value: number;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(formatSIValue(value, unit));
  const [invalid, setInvalid] = useState(false);

  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        className={invalid ? "field-input field-input-invalid" : "field-input"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
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

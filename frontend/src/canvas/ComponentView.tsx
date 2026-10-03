import { useMemo } from "react";
import type { ComponentInstance, PinRef } from "../types/circuit";
import { getDef } from "../domain/componentDefs";
import { GRID_SIZE } from "../utils/geometry";
import { SYMBOLS } from "./symbols";
import { formatSIValue } from "../utils/units";

interface Props {
  component: ComponentInstance;
  selected: boolean;
  hoveredPin: string | null;
  onPointerDownBody: (e: React.PointerEvent) => void;
  onPinPointerDown: (pin: PinRef, e: React.PointerEvent) => void;
  onPinPointerUp: (pin: PinRef, e: React.PointerEvent) => void;
  onPinPointerEnter: (pinId: string) => void;
  onPinPointerLeave: () => void;
  isPinConnected: (pinId: string) => boolean;
}

export function ComponentView({
  component,
  selected,
  hoveredPin,
  onPointerDownBody,
  onPinPointerDown,
  onPinPointerUp,
  onPinPointerEnter,
  onPinPointerLeave,
  isPinConnected,
}: Props) {
  const def = getDef(component.kind);
  const Symbol = SYMBOLS[def.symbolId];

  const cx = component.x * GRID_SIZE;
  const cy = component.y * GRID_SIZE;
  const scaleX = component.mirrored ? -1 : 1;

  const stroke = selected ? "var(--amber)" : "var(--text-primary)";

  const valueLabel = useMemo(() => {
    const p = def.params[0];
    if (!p) return null;
    return formatSIValue(component.params[p.key] ?? p.default, p.unit);
  }, [def, component.params]);

  return (
    <g
      transform={`translate(${cx}, ${cy})`}
      data-component-id={component.id}
    >
      {/* rotation applied here so pins (rendered in unrotated local space
          below) can independently use the same transform for hit-testing */}
      <g
        transform={`rotate(${component.rotation}) scale(${scaleX}, 1)`}
        onPointerDown={onPointerDownBody}
        style={{ cursor: "grab" }}
      >
        {selected && (
          <rect
            x={-def.size.w * GRID_SIZE * 0.55}
            y={-def.size.h * GRID_SIZE * 0.9}
            width={def.size.w * GRID_SIZE * 1.1}
            height={def.size.h * GRID_SIZE * 1.8}
            fill="rgba(255,180,84,0.08)"
            stroke="none"
            rx={6}
          />
        )}
        <Symbol stroke={stroke} />
      </g>

      {/* Pins: drawn in a separate, un-mirrored-but-rotated group so pin
          hit targets always sit exactly on the wire endpoints computed
          by resolvePinWorld (mirroring only affects the artwork, not
          electrical topology). */}
      <g transform={`rotate(${component.rotation})`}>
        {def.pins.map((pin) => {
          const px = (component.mirrored ? -pin.local.x : pin.local.x) * GRID_SIZE;
          const py = pin.local.y * GRID_SIZE;
          const connected = isPinConnected(pin.id);
          const isHovered = hoveredPin === pin.id;
          return (
            <circle
              key={pin.id}
              cx={px}
              cy={py}
              r={isHovered ? 7 : 4.5}
              fill={
                isHovered
                  ? "var(--amber)"
                  : connected
                  ? "var(--phosphor)"
                  : "var(--bg-canvas)"
              }
              stroke={connected ? "var(--phosphor)" : "var(--text-dim)"}
              strokeWidth={1.5}
              style={{ cursor: "crosshair" }}
              onPointerEnter={() => onPinPointerEnter(pin.id)}
              onPointerLeave={onPinPointerLeave}
              onPointerDown={(e) => {
                e.stopPropagation();
                onPinPointerDown({ componentId: component.id, pinId: pin.id }, e);
              }}
              onPointerUp={(e) => {
                onPinPointerUp({ componentId: component.id, pinId: pin.id }, e);
              }}
            />
          );
        })}
      </g>

      <text
        x={0}
        y={-def.size.h * GRID_SIZE * 0.75 - 6}
        textAnchor="middle"
        fontSize={11}
        fill="var(--text-primary)"
        fontFamily="var(--font-mono)"
      >
        {component.refId}
      </text>
      {valueLabel && (
        <text
          x={0}
          y={-def.size.h * GRID_SIZE * 0.75 + 10}
          textAnchor="middle"
          fontSize={10}
          fill="var(--text-dim)"
          fontFamily="var(--font-mono)"
        >
          {valueLabel}
        </text>
      )}
    </g>
  );
}

import { useMemo } from "react";
import type { ComponentInstance, PinRef } from "../types/circuit";
import { getDef } from "../domain/componentDefs";
import { GRID_SIZE, axisScale, transformLocal } from "../utils/geometry";
import { SYMBOLS } from "./symbols";
import { formatSIValue } from "../utils/units";
import type { BranchInfo } from "../api/simulate";

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
  /** NEW (optional): branch analysis result for this component from last simulation */
  branchInfo?: BranchInfo | null;
  /** Inspect (eye) mode is on and this part has results: a click shows its stats. */
  inspectable?: boolean;
  /** Ref-id and value text beside the symbol. */
  showLabels?: boolean;
  /** Whether the branch analysis badge should be displayed */
  showBranchBadge?: boolean;
  /** Callback when user clicks to toggle the branch badge */
  onToggleBranchBadge?: () => void;
  /** Callback when user clicks on component body */
  onClickBody?: (e: React.MouseEvent) => void;
}



export function ComponentView({
  component,
  showLabels = true,
  selected,
  hoveredPin,
  onPointerDownBody,
  onPinPointerDown,
  onPinPointerUp,
  onPinPointerEnter,
  onPinPointerLeave,
  isPinConnected,
  branchInfo,
  inspectable = false,
  showBranchBadge = false,
  onToggleBranchBadge,
  onClickBody,
}: Props) {
  const def = getDef(component.kind);
  const Symbol = SYMBOLS[def.symbolId];

  const cx = component.x * GRID_SIZE;
  const cy = component.y * GRID_SIZE;
  const scaleX = (component.mirrored ? -1 : 1) * axisScale(component.rotation);

  const stroke = selected ? "var(--select)" : "var(--text-primary)";

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
      <g
        transform={`rotate(${component.rotation}) scale(${scaleX}, 1)`}
        onPointerDown={onPointerDownBody}
        onClick={onClickBody}
        style={{ cursor: inspectable ? "pointer" : "grab" }}
      >
        {selected && (
          <rect
            x={-def.size.w * GRID_SIZE * 0.55}
            y={-def.size.h * GRID_SIZE * 0.9}
            width={def.size.w * GRID_SIZE * 1.1}
            height={def.size.h * GRID_SIZE * 1.8}
            fill="rgba(77,163,255,0.08)"
            stroke="none"
            rx={6}
          />
        )}
        <Symbol stroke={stroke} />
      </g>

      <g>
        {def.pins.map((pin) => {
          const t = transformLocal(pin.local, component.rotation, component.mirrored);
          const px = t.x * GRID_SIZE;
          const py = t.y * GRID_SIZE;
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
              onClick={(e) => {
                e.stopPropagation();
              }}
            />
          );
        })}
      </g>

      {/* ref + value labels. They take the side the readings never use:
          above a horizontal part (V/I popup goes below, node pills sit out
          past the pins) and left of a vertical one (popup and pills go to
          the right). Ground symbols aren't labelled. */}
      {showLabels && component.kind !== "ground" && (() => {
        const rot = ((component.rotation % 360) + 360) % 360;
        const vertical = rot === 90 || rot === 270;
        const top = -def.size.h * GRID_SIZE * 0.5;
        const ref = vertical
          ? { x: -14, y: valueLabel ? -2 : 4, anchor: "end" as const }
          : { x: 0, y: top - (valueLabel ? 16 : 5), anchor: "middle" as const };
        const val = vertical
          ? { x: -14, y: 11, anchor: "end" as const }
          : { x: 0, y: top - 4, anchor: "middle" as const };
        return (
          <g pointerEvents="none">
            <text x={ref.x} y={ref.y} textAnchor={ref.anchor} fontSize={11}
              fill="var(--text-primary)" fontFamily="var(--font-label)">
              {component.refId}
            </text>
            {valueLabel && (
              <text x={val.x} y={val.y} textAnchor={val.anchor} fontSize={10}
                fill="var(--text-dim)" fontFamily="var(--font-label)">
                {valueLabel}
              </text>
            )}
          </g>
        );
      })()}

      {/* ── simulation analysis badge (toggled by clicking with the eye on) ── */}
      {showBranchBadge && branchInfo && (() => {
        const dv = branchInfo.delta_v;
        const ia = branchInfo.current_a;
        const dir = branchInfo.direction;

        // ΔV: show absolute value; clamp < 1mV strictly to "0.00 V"
        const absDv = Math.abs(dv);
        const dvText = (() => {
          if (absDv < 1e-3) return "0.00 V";
          if (absDv >= 1)    return `${absDv.toFixed(2)} V`;
          return `${(absDv * 1e3).toFixed(1)} mV`;
        })();

        // I: always show absolute magnitude; direction conveyed by arrow
        const absIa = Math.abs(ia);
        const iaText = (() => {
          if (absIa === 0)    return "0 A";
          if (absIa >= 1)     return `${absIa.toFixed(2)} A`;
          if (absIa >= 1e-3)  return `${(absIa * 1e3).toFixed(1)} mA`;
          if (absIa >= 1e-6)  return `${(absIa * 1e6).toFixed(1)} µA`;
          if (absIa >= 1e-9)  return `${(absIa * 1e9).toFixed(1)} nA`;
          return `${absIa.toExponential(1)} A`;
        })();

        // Direction arrow: → means current flows a→b (from p1 to p2)
        const dirArrow =
          dir === "a_to_b" ? "→" :
          dir === "b_to_a" ? "←" : "·";
        // Amber for active flow, gray for no current
        const dirColor = dir === "none" ? "#64748b" : "var(--sim-current)";

        // Popup alignment relative to component bounds:
        // - Horizontal components: centered directly beneath the component body
        // - Vertical components: alongside the component body to the right with clear margin
        // - Diagonal components: offset outward
        const isVertical = component.rotation === 90 || component.rotation === 270;
        const isDiagonalRot = component.rotation % 90 !== 0;

        const bw = 92;
        const bh = 42;

        let bx = -bw / 2;
        let by = def.size.h * GRID_SIZE * 0.6 + 14;

        if (isVertical) {
          bx = def.size.w * GRID_SIZE * 0.5 + 16;
          by = -bh / 2;
        } else if (isDiagonalRot) {
          bx = 24;
          by = 24;
        } else {
          bx = -bw / 2;
          by = def.size.h * GRID_SIZE * 0.6 + 14;
        }

        return (
          <g
            className="branch-badge"
            pointerEvents="auto"
            onClick={(e) => {
              e.stopPropagation();
              onToggleBranchBadge?.();
            }}
            style={{ cursor: "pointer" }}
          >
            <title>Click to hide measurements</title>
            {/* main card */}
            <rect x={bx} y={by} width={bw} height={bh}
              rx={3}
              fill="#23272c"
              stroke="#454c55"
              strokeWidth={1}
            />
            {/* left accent bar */}
            <rect x={bx} y={by} width={3} height={bh}
              rx={1} fill="var(--text-faint)"
            />

            {/* ΔV row */}
            <text x={bx + 10} y={by + 14}
              fontSize={9} fontFamily="var(--font-label)"
              fontWeight={600} fill="var(--sim-voltage)">
              {"ΔV"}
            </text>
            <text x={bx + 28} y={by + 14}
              fontSize={9} fontFamily="var(--font-label)"
              fontWeight={700} fill="var(--sim-voltage)">
              {dvText}
            </text>

            {/* I row */}
            <text x={bx + 10} y={by + 28}
              fontSize={9} fontFamily="var(--font-label)"
              fontWeight={600} fill="var(--sim-current)">
              {"I"}
            </text>
            <text x={bx + 22} y={by + 28}
              fontSize={9} fontFamily="var(--font-label)"
              fontWeight={700} fill="var(--sim-current)">
              {iaText}
            </text>

            {/* direction chip */}
            <rect x={bx + bw - 18} y={by + 18}
              width={16} height={14}
              rx={3} fill={dirColor} opacity={0.18}
              stroke={dirColor} strokeWidth={0.7}
            />
            <text x={bx + bw - 10} y={by + 28}
              textAnchor="middle"
              fontSize={10} fontFamily="var(--font-label)"
              fontWeight={900} fill={dirColor}>
              {dirArrow}
            </text>

            {/* close x icon */}
            <text x={bx + bw - 7} y={by + 9}
              textAnchor="middle"
              fontSize={9} fontFamily="var(--font-label)"
              fill="#64748b" opacity={0.7}>
              {"×"}
            </text>
          </g>
        );
      })()}
    </g>
  );
}
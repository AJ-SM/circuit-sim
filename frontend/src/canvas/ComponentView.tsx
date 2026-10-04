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
}

/** Format Amperes to a compact human string, e.g. 0.005 -> "5.00mA" */
function fmtAmps(a: number): string {
  const abs = Math.abs(a);
  if (abs === 0) return "0A";
  if (abs >= 1) return `${a.toFixed(3)}A`;
  if (abs >= 1e-3) return `${(a * 1e3).toFixed(2)}mA`;
  if (abs >= 1e-6) return `${(a * 1e6).toFixed(2)}uA`;
  if (abs >= 1e-9) return `${(a * 1e9).toFixed(2)}nA`;
  return `${a.toExponential(2)}A`;
}

/** Format Volts to a compact human string */
function fmtVolts(v: number): string {
  const abs = Math.abs(v);
  if (abs === 0) return "0V";
  if (abs >= 1) return `${v.toFixed(3)}V`;
  if (abs >= 1e-3) return `${(v * 1e3).toFixed(2)}mV`;
  return `${v.toExponential(2)}V`;
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
  branchInfo,
}: Props) {
  const def = getDef(component.kind);
  const Symbol = SYMBOLS[def.symbolId];

  const cx = component.x * GRID_SIZE;
  const cy = component.y * GRID_SIZE;
  const scaleX = (component.mirrored ? -1 : 1) * axisScale(component.rotation);

  const stroke = selected ? "var(--amber)" : "var(--text-primary)";

  const valueLabel = useMemo(() => {
    const p = def.params[0];
    if (!p) return null;
    return formatSIValue(component.params[p.key] ?? p.default, p.unit);
  }, [def, component.params]);

  // Badge position: below the ref-id label (above the component body center)
  const badgeY = -def.size.h * GRID_SIZE * 0.75 + 26;

  return (
    <g
      transform={`translate(${cx}, ${cy})`}
      data-component-id={component.id}
    >
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
            />
          );
        })}
      </g>

      {/* ref-id label */}
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

      {/* value label */}
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

      {/* ── simulation analysis badge ── */}
      {branchInfo && (() => {
        const dv = branchInfo.delta_v;
        const ia = branchInfo.current_a;
        const dir = branchInfo.direction;

        const dvText = (() => {
          const abs = Math.abs(dv);
          if (abs < 1e-9) return "0.00 V";
          if (abs >= 1)   return `${dv.toFixed(2)} V`;
          if (abs >= 1e-3) return `${(dv * 1e3).toFixed(1)} mV`;
          return `${dv.toExponential(1)} V`;
        })();

        const iaText = (() => {
          const abs = Math.abs(ia);
          if (abs === 0)   return "0 A";
          if (abs >= 1)    return `${ia.toFixed(2)} A`;
          if (abs >= 1e-3) return `${(ia * 1e3).toFixed(1)} mA`;
          if (abs >= 1e-6) return `${(ia * 1e6).toFixed(1)} µA`;
          if (abs >= 1e-9) return `${(ia * 1e9).toFixed(1)} nA`;
          return `${ia.toExponential(1)} A`;
        })();

        const dirArrow =
          dir === "a_to_b" ? "→" :
          dir === "b_to_a" ? "←" : "·";
        const dirColor =
          dir === "none" ? "#888" : "#6effb0";

        const bx = -46;
        const by = badgeY - 2;
        const bw = 92;
        const bh = 42;

        return (
          <g className="branch-badge" pointerEvents="none">
            {/* glow halo */}
            <rect x={bx - 2} y={by - 2} width={bw + 4} height={bh + 4}
              rx={7} fill="rgba(110,255,176,0.06)"
              style={{ filter: "blur(6px)" }}
            />
            {/* main card */}
            <rect x={bx} y={by} width={bw} height={bh}
              rx={5}
              fill="rgba(6,10,8,0.92)"
              stroke="rgba(110,255,176,0.22)"
              strokeWidth={1}
            />
            {/* left accent bar */}
            <rect x={bx} y={by} width={3} height={bh}
              rx={2} fill="#6effb0" opacity={0.7}
            />

            {/* ΔV row */}
            <text x={bx + 10} y={by + 14}
              fontSize={9} fontFamily="var(--font-mono)"
              fontWeight={600} fill="#6cb6ff">
              {"ΔV"}
            </text>
            <text x={bx + 28} y={by + 14}
              fontSize={9} fontFamily="var(--font-mono)"
              fontWeight={700} fill="#c8e6ff">
              {dvText}
            </text>

            {/* I row */}
            <text x={bx + 10} y={by + 28}
              fontSize={9} fontFamily="var(--font-mono)"
              fontWeight={600} fill="#ffb454">
              {"I"}
            </text>
            <text x={bx + 22} y={by + 28}
              fontSize={9} fontFamily="var(--font-mono)"
              fontWeight={700} fill="#ffe0a0">
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
              fontSize={10} fontFamily="var(--font-mono)"
              fontWeight={900} fill={dirColor}>
              {dirArrow}
            </text>
          </g>
        );
      })()}
    </g>
  );
}
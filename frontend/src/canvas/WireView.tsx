import { useMemo } from "react";
import { GRID_SIZE, orthogonalPath, routedPath } from "../utils/geometry";
import type { WireRoute } from "../types/circuit";

interface Props {
  points: { x: number; y: number }[];
  dirs?: ({ x: number; y: number } | undefined)[];
  selected: boolean;
  route?: WireRoute;
  onPointerDown: (e: React.PointerEvent, dragAxis?: "x" | "y") => void;
  currentAmperes?: number;
  currentDirection?: "a_to_b" | "b_to_a" | "none";
  avgVoltage?: number;
  maxVoltage?: number;
  showCurrentLabel?: boolean;
}

/** Format amps compactly: 0.005 → "5.0mA" */
function fmtAmps(a: number): string {
  const abs = Math.abs(a);
  if (abs === 0) return "0 A";
  if (abs >= 1)    return `${a.toFixed(2)} A`;
  if (abs >= 1e-3) return `${(a * 1e3).toFixed(1)} mA`;
  if (abs >= 1e-6) return `${(a * 1e6).toFixed(1)} µA`;
  if (abs >= 1e-9) return `${(a * 1e9).toFixed(1)} nA`;
  return `${a.toExponential(1)} A`;
}

/**
 * Map a node's actual potential to a color using standard EE conventions:
 *   0 V (GND)  → cool cyan/blue  (#38bdf8)
 *   mid range  → phosphor green  (#6effb0)
 *   high +V    → warm amber/red  (#ffb454 → #f87171)
 * `v` is the signed voltage; `maxV` is the max absolute voltage in the circuit.
 */
function voltageColor(v: number, maxV: number): string {
  if (maxV === 0) return "var(--phosphor)";
  // Normalize 0..1 where 0 = ground potential, 1 = highest node
  const t = Math.min(1, Math.max(0, v / maxV));
  if (t < 0.15) {
    // Near ground: cyan/blue
    return "#38bdf8";
  } else if (t < 0.5) {
    // Low-mid: cyan → green
    const s = (t - 0.15) / 0.35;
    return `rgb(${Math.round(56 + s * 54)},${Math.round(189 + s * 66)},${Math.round(248 - s * 72)})`;
  } else {
    // Mid-high: green → amber → red
    const s = (t - 0.5) / 0.5;
    return `rgb(${Math.round(110 + s * 145)},${Math.round(255 - s * 138)},${Math.round(176 - s * 163)})`;
  }
}

function flowSpeed(amps: number): string {
  const abs = Math.abs(amps);
  if (abs <= 0)     return "1.5s";
  if (abs >= 1)     return "0.25s";
  if (abs >= 0.01)  return "0.4s";
  if (abs >= 0.001) return "0.7s";
  return "1.2s";
}

export function WireView({
  points, dirs, selected, route, onPointerDown,
  currentAmperes, currentDirection, avgVoltage, maxVoltage,
  showCurrentLabel = false,
}: Props) {
  if (points.length < 2) return null;
  const [a, b] = points;
  const grid = route
    ? routedPath(a, b, dirs?.[0], dirs?.[1], route)
    : orthogonalPath(a, b, dirs?.[0], dirs?.[1]);
  const routed = grid.map((p) => ({ x: p.x * GRID_SIZE, y: p.y * GRID_SIZE }));
  const d = routed.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

  // Find the longest segment in the routed path to place the arrowhead & badge.
  // This guarantees placing on the open wire stretch rather than near pins/junctions.
  let bestMidX = (routed[0].x + routed[routed.length - 1].x) / 2;
  let bestMidY = (routed[0].y + routed[routed.length - 1].y) / 2;
  let bestAngle = 0;
  let maxSegLen = -1;

  for (let i = 0; i < routed.length - 1; i++) {
    const p1 = routed[i];
    const p2 = routed[i + 1];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    if (len > maxSegLen) {
      maxSegLen = len;
      bestMidX = (p1.x + p2.x) / 2;
      bestMidY = (p1.y + p2.y) / 2;
      bestAngle = Math.atan2(dy, dx) * (180 / Math.PI);
    }
  }

  const midX = bestMidX;
  const midY = bestMidY;
  const angle = bestAngle;

  const hasFlow = currentAmperes !== undefined && Math.abs(currentAmperes) > 1e-15;
  const isReverse = currentDirection === "b_to_a";
  const arrowAngle = isReverse ? angle + 180 : angle;

  const wireColor = useMemo(() => {
    if (selected) return "var(--amber)";
    if (avgVoltage !== undefined && maxVoltage !== undefined && maxVoltage > 0) {
      return voltageColor(avgVoltage, maxVoltage);
    }
    return "var(--phosphor)";
  }, [selected, avgVoltage, maxVoltage]);

  const flowClass = hasFlow ? (isReverse ? "wire-flow-reverse" : "wire-flow-forward") : "";
  const speed = hasFlow ? flowSpeed(currentAmperes!) : "1s";

  // Current label: always show absolute magnitude — direction is shown by the arrow
  const currentLabel = hasFlow ? fmtAmps(Math.abs(currentAmperes!)) : null;
  const labelW = currentLabel ? Math.max(36, currentLabel.length * 6.2 + 10) : 0;

  // Determine label offset direction (strictly adjacent with clean clearance)
  const rad = (angle * Math.PI) / 180;
  const isHorizontal = Math.abs(Math.sin(rad)) < 0.2;
  const isVertical = Math.abs(Math.cos(rad)) < 0.2;

  let labelOffsetX = 0;
  let labelOffsetY = -16;

  if (isHorizontal) {
    labelOffsetX = 0;
    labelOffsetY = -16; // 16px strictly above the horizontal line
  } else if (isVertical) {
    labelOffsetX = 18;  // 18px strictly to the side of the vertical line
    labelOffsetY = 0;
  } else {
    labelOffsetX = Math.sin(rad) * 18;
    labelOffsetY = -Math.cos(rad) * 18;
  }

  return (
    <g>
      {/* wide invisible hit target */}
      {routed.slice(1).map((p, i) => {
        const q = routed[i];
        const axis = q.y === p.y ? "y" : "x";
        return (
          <line key={i} x1={q.x} y1={q.y} x2={p.x} y2={p.y}
            stroke="transparent" strokeWidth={14}
            onPointerDown={(e) => onPointerDown(e, axis)}
            style={{ cursor: axis === "y" ? "ns-resize" : "ew-resize" }}
          />
        );
      })}

      {/* glow halo behind active wire */}
      {hasFlow && (
        <path d={d} stroke={wireColor} strokeWidth={5} fill="none"
          strokeLinecap="round" strokeLinejoin="round"
          pointerEvents="none" opacity={0.18}
        />
      )}

      {/* base wire */}
      <path d={d} stroke={wireColor}
        strokeWidth={hasFlow ? 2.5 : (selected ? 2.5 : 2)}
        fill="none" strokeLinecap="round" strokeLinejoin="round"
        pointerEvents="none" opacity={hasFlow ? 0.55 : 1}
      />

      {/* animated flow dashes */}
      {hasFlow && (
        <path d={d} stroke={wireColor} strokeWidth={hasFlow ? 3 : 2.5}
          fill="none" strokeLinecap="round" strokeLinejoin="round"
          pointerEvents="none" strokeDasharray="8 16"
          className={flowClass}
          style={{ animationDuration: speed, filter: `drop-shadow(0 0 4px ${wireColor})` }}
        />
      )}

      {/* direction arrowhead at midpoint — larger and filled */}
      {hasFlow && (
        <g transform={`translate(${midX}, ${midY}) rotate(${arrowAngle})`} pointerEvents="none">
          {/* arrow shadow glow */}
          <polygon points="-8,-5 9,0 -8,5"
            fill={wireColor} opacity={0.25}
            style={{ filter: `blur(3px)` }}
          />
          {/* arrow body */}
          <polygon points="-7,-4.5 8,0 -7,4.5"
            fill={wireColor} opacity={0.95}
            style={{ filter: `drop-shadow(0 0 3px ${wireColor})` }}
          />
        </g>
      )}

      {/* current magnitude label near the arrow (shown on select or when toggled) */}
      {hasFlow && currentLabel && (selected || showCurrentLabel) && (
        <g
          transform={`translate(${midX + labelOffsetX}, ${midY + labelOffsetY})`}
          pointerEvents="none"
        >
          <rect
            x={-labelW / 2}
            y={-9}
            width={labelW}
            height={13}
            rx={3}
            fill="rgba(6,10,8,0.88)"
            stroke={wireColor}
            strokeWidth={0.8}
          />
          <text
            x={0}
            y={1}
            textAnchor="middle"
            fontSize={8}
            fontFamily="var(--font-mono)"
            fontWeight={700}
            fill={wireColor}
          >
            {currentLabel}
          </text>
        </g>
      )}
    </g>
  );
}

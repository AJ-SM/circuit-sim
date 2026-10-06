import { GRID_SIZE, orthogonalPath, routedPath } from "../utils/geometry";
import type { WireRoute } from "../types/circuit";

export type VoltageEnd = "into" | "out";

/** Distance (px) from a pin at which its voltage arrow sits. */
const VOLTAGE_ARROW_INSET = 20;

/** Point and heading (deg) at `dist` px along a polyline. */
function pointAlong(path: { x: number; y: number }[], dist: number) {
  let left = dist;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    if (left <= len || i === path.length - 2) {
      const t = Math.min(1, left / len);
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
      };
    }
    left -= len;
  }
  return { x: path[0].x, y: path[0].y, angle: 0 };
}

/** The part of a polyline between `d0` and `d1` px along it. */
function slicePath(path: { x: number; y: number }[], d0: number, d1: number) {
  const out: { x: number; y: number }[] = [];
  let walked = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const s0 = Math.max(d0, walked), s1 = Math.min(d1, walked + len);
    if (len > 0 && s1 > s0) {
      const at = (s: number) => ({
        x: a.x + ((b.x - a.x) * (s - walked)) / len,
        y: a.y + ((b.y - a.y) * (s - walked)) / len,
      });
      if (out.length === 0) out.push(at(s0));
      out.push(at(s1));
    }
    walked += len;
  }
  return out;
}

const toD = (pts: { x: number; y: number }[]) =>
  pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

/** The filled arrowhead used for both current and voltage direction. */
function Arrowhead({ x, y, angle, color }: { x: number; y: number; angle: number; color: string }) {
  return (
    <g transform={`translate(${x}, ${y}) rotate(${angle})`} pointerEvents="none">
      <polygon points="-6,-4 7,0 -6,4" fill={color} />
    </g>
  );
}

interface Props {
  points: { x: number; y: number }[];
  dirs?: ({ x: number; y: number } | undefined)[];
  selected: boolean;
  route?: WireRoute;
  onPointerDown: (e: React.PointerEvent, dragAxis?: "x" | "y") => void;
  currentAmperes?: number;
  currentDirection?: "a_to_b" | "b_to_a" | "none";
  avgVoltage?: number;
  /** Draw flow arrows and moving dashes when current flows. */
  showFlow?: boolean;
  /** Voltage-direction arrows near each end, relative to the part on that
   *  end: "into" = the wire meets the part's + end (voltage drops into it),
   *  "out" = it meets the part's − end (voltage leaves it). */
  voltageArrows?: { start?: VoltageEnd; end?: VoltageEnd };
  /** Value tag shown on the wire regardless of selection. */
  labelMode?: "off" | "current" | "voltage" | "both";
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

/** Format volts compactly: 2.5 → "2.50 V"; |V| < 1 mV → "0 V" */
function fmtVolts(v: number): string {
  const abs = Math.abs(v);
  if (abs < 1e-3) return "0 V";
  if (abs >= 1) return `${v.toFixed(2)} V`;
  return `${(v * 1e3).toFixed(1)} mV`;
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
  currentAmperes, currentDirection, avgVoltage,
  showFlow = true, labelMode = "off", voltageArrows,
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

  const carriesCurrent = currentAmperes !== undefined && Math.abs(currentAmperes) > 1e-15;
  const hasFlow = showFlow && carriesCurrent;
  const isReverse = currentDirection === "b_to_a";
  const arrowAngle = isReverse ? angle + 180 : angle;

  // Wires are one colour whatever their potential; current flow is drawn
  // over them in the current colour.
  const wireColor = selected ? "var(--select)" : "var(--phosphor)";
  const flowColor = "var(--sim-current)";
  const voltColor = "var(--sim-voltage)";

  // Voltage arrows sit just inside each end so they don't cover the
  // current arrow in the middle. Headings follow the drop: into a part's
  // + end, out of its − end.
  const totalLen = routed.slice(1).reduce(
    (sum, p, i) => sum + Math.hypot(p.x - routed[i].x, p.y - routed[i].y), 0);
  const inset = Math.min(VOLTAGE_ARROW_INSET, totalLen * 0.3);
  const vArrows: { x: number; y: number; angle: number }[] = [];
  if (voltageArrows?.start) {
    const p = pointAlong(routed, inset);
    vArrows.push({ ...p, angle: voltageArrows.start === "into" ? p.angle + 180 : p.angle });
  }
  if (voltageArrows?.end) {
    const p = pointAlong(routed, Math.max(0, totalLen - inset));
    vArrows.push({ ...p, angle: voltageArrows.end === "into" ? p.angle : p.angle + 180 });
  }

  // Moving voltage dots, in the same directions as the voltage arrows. When
  // the two ends disagree (e.g. a source's + wired to a resistor's +), each
  // half of the wire moves toward its own part.
  const startFwd = voltageArrows?.start ? voltageArrows.start === "out" : undefined;
  const endFwd = voltageArrows?.end ? voltageArrows.end === "into" : undefined;
  const vFlows: { d: string; forward: boolean }[] = [];
  if (startFwd !== undefined && endFwd !== undefined && startFwd !== endFwd) {
    vFlows.push({ d: toD(slicePath(routed, 0, totalLen / 2)), forward: startFwd });
    vFlows.push({ d: toD(slicePath(routed, totalLen / 2, totalLen)), forward: endFwd });
  } else if (startFwd !== undefined || endFwd !== undefined) {
    vFlows.push({ d, forward: (startFwd ?? endFwd)! });
  }

  const flowClass = hasFlow ? (isReverse ? "wire-flow-reverse" : "wire-flow-forward") : "";
  const speed = hasFlow ? flowSpeed(currentAmperes!) : "1s";

  // Current: always the absolute magnitude — direction is shown by the arrow.
  // Selecting the wire shows its current even when the wire-label mode
  // leaves it out. Inspecting a part never adds wire labels.
  const wantCurrent = labelMode === "current" || labelMode === "both" || selected;
  const wantVoltage = labelMode === "voltage" || labelMode === "both";
  const iText = wantCurrent && carriesCurrent ? fmtAmps(Math.abs(currentAmperes!)) : null;
  const vText = wantVoltage && avgVoltage !== undefined ? fmtVolts(avgVoltage) : null;
  const currentLabel = iText || vText ? [iText, vText].filter(Boolean).join(" · ") : null;

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


      {/* base wire */}
      <path d={d} stroke={wireColor}
        strokeWidth={selected ? 2.5 : 2}
        fill="none" strokeLinecap="round" strokeLinejoin="round"
        pointerEvents="none"
      />

      {/* animated flow dashes */}
      {hasFlow && (
        <path d={d} stroke={flowColor} strokeWidth={2}
          fill="none" strokeLinecap="round" strokeLinejoin="round"
          pointerEvents="none" strokeDasharray="7 17"
          className={flowClass}
          style={{ animationDuration: speed }}
        />
      )}

      {/* animated voltage dots (short round dashes, so they read apart from current) */}
      {vFlows.map((f, i) => (
        <path key={i} d={f.d} stroke={voltColor} strokeWidth={2.8}
          fill="none" strokeLinecap="round" strokeLinejoin="round"
          pointerEvents="none" strokeDasharray="0.1 11.9"
          className={f.forward ? "wire-flow-forward" : "wire-flow-reverse"}
          style={{ animationDuration: "1.1s" }}
        />
      ))}

      {/* current direction: arrowhead at the midpoint */}
      {hasFlow && <Arrowhead x={midX} y={midY} angle={arrowAngle} color={flowColor} />}

      {/* voltage direction: the same arrowhead near each end */}
      {vArrows.map((a, i) => (
        <Arrowhead key={i} x={a.x} y={a.y} angle={a.angle} color={voltColor} />
      ))}

      {/* value labels near the current arrow: solid pills, current then voltage */}
      {currentLabel && (() => {
        const pills = [
          iText && { text: iText, color: flowColor },
          vText && { text: vText, color: voltColor },
        ].filter(Boolean) as { text: string; color: string }[];
        const widths = pills.map((p) => Math.max(34, p.text.length * 5.6 + 10));
        const gap = 3;
        const total = widths.reduce((s, w) => s + w, 0) + gap * (pills.length - 1);
        let x = -total / 2;
        return (
          <g transform={`translate(${midX + labelOffsetX}, ${midY + labelOffsetY})`} pointerEvents="none">
            {pills.map((p, i) => {
              const w = widths[i];
              const px = x;
              x += w + gap;
              return (
                <g key={i}>
                  <rect x={px} y={-9} width={w} height={13} rx={6.5} fill={p.color} />
                  <text x={px + w / 2} y={1} textAnchor="middle" fontSize={8}
                    fontFamily="var(--font-label)" fontWeight={700} fill="var(--sim-label-ink)">
                    {p.text}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })()}
    </g>
  );
}

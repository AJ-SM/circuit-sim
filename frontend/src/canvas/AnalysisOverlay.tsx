import type { BranchInfo } from "../api/simulate";
import { GRID_SIZE } from "../utils/geometry";

export interface NodeVoltageLabel {
  x: number;
  y: number;
  voltage: number;
  nodeId: string;
  componentId?: string;
  pinDir?: { x: number; y: number };
  compRotation?: number;
  isGround?: boolean;
  /** The pin belongs to a ground symbol (not just a part tied to 0 V). */
  isGroundSymbol?: boolean;
}

interface Props {
  nodeLabels: NodeVoltageLabel[];
  visibleComponentIds?: Set<string> | null;
}

/** Format voltage: any |V| < 1mV or GND strictly displays as "0.00 V" */
export function fmtVolts(v: number): string {
  const abs = Math.abs(v);
  if (abs < 0.001) return "0.00 V";
  if (abs >= 1)    return `${v.toFixed(2)} V`;
  return `${(v * 1e3).toFixed(1)} mV`;
}

/**
 * Where a node-voltage pill goes relative to its pin, chosen so it never
 * lands on the part's ref/value labels or its V/I popup:
 * - Horizontal part: just outside the pin, above the wire (labels are above
 *   the body, between the pins; the popup is below).
 * - Vertical part: to the right, beyond the pin (labels are on the left; the
 *   popup is to the right but level with the body, between the pins).
 * - Ground symbol: to the right of its single pin.
 */
function computeNodeBadgeOffset(lbl: NodeVoltageLabel, textW: number): { x: number; y: number } {
  const dir = lbl.pinDir ?? { x: 0, y: 0 };
  if (lbl.isGroundSymbol) return { x: textW / 2 + 12, y: 0 };

  const rot = (((lbl.compRotation ?? 0) % 360) + 360) % 360;
  if (rot === 90 || rot === 270) {
    return { x: textW / 2 + 8, y: (dir.y < 0 ? -1 : 1) * 16 };
  }
  if (rot % 90 === 0) {
    return { x: (dir.x < 0 ? -1 : 1) * (textW / 2 + 6), y: -11 };
  }
  // Diagonal parts: outward along the pin, nudged up.
  return { x: dir.x * (textW / 2 + 6), y: dir.y * 12 - 6 };
}

/**
 * SVG overlay: renders clean voltage "pill" labels at resolved pins/junctions.
 */
export function AnalysisOverlay({ nodeLabels, visibleComponentIds }: Props) {
  const displayed = visibleComponentIds !== undefined && visibleComponentIds !== null
    ? nodeLabels.filter((lbl) => lbl.componentId && visibleComponentIds.has(lbl.componentId))
    : nodeLabels;

  if (displayed.length === 0) return null;

  return (
    <g className="analysis-overlay" pointerEvents="none">
      {displayed.map((lbl) => {
        const px = lbl.x * GRID_SIZE;
        const py = lbl.y * GRID_SIZE;
        const isZero = Math.abs(lbl.voltage) < 0.001 || lbl.nodeId.startsWith("0:") || !!lbl.isGround;
        const text = isZero ? "0.00 V" : fmtVolts(lbl.voltage);
        const color = "var(--sim-voltage)";
        const textW = Math.max(46, text.length * 6.6 + 14);
        const pillH = 18;
        const offset = computeNodeBadgeOffset(lbl, textW);

        return (
          <g key={lbl.nodeId} transform={`translate(${px}, ${py})`}>
            {/* Terminal junction dot */}
            <circle cx={0} cy={0} r={3.5} fill={color} />

            {/* Non-overlapping voltage pill badge */}
            <g transform={`translate(${offset.x}, ${offset.y})`}>
              {/* pill background */}
              <rect
                x={-textW / 2}
                y={-pillH / 2}
                width={textW}
                height={pillH}
                rx={pillH / 2}
                fill={color}
              />
              {/* voltage text */}
              <text
                x={0}
                y={3.8}
                textAnchor="middle"
                fontSize={10.5}
                fontFamily="var(--font-label)"
                fontWeight={700}
                fill="var(--sim-label-ink)"
              >
                {text}
              </text>
            </g>
          </g>
        );
      })}
    </g>
  );
}

// ── Helper ─────────────────────────────────────────────────────────────────────

export interface PinWorldPos {
  componentId: string;
  pinId: string;
  nodeId: string;
  x: number;
  y: number;
  pinDir?: { x: number; y: number };
  compRotation?: number;
  isGround?: boolean;
  isGroundSymbol?: boolean;
}

export function buildNodeLabels(
  branchAnalysis: BranchInfo[],
  pinWorldPositions: PinWorldPos[]
): NodeVoltageLabel[] {
  const nodeVoltage = new Map<string, number>();
  for (const b of branchAnalysis) {
    nodeVoltage.set(b.node_a, b.voltage_a);
    nodeVoltage.set(b.node_b, b.voltage_b);
  }
  // "0" is always GND (strictly 0.0 V)
  nodeVoltage.set("0", 0);

  const seen = new Set<string>();
  const labels: NodeVoltageLabel[] = [];

  for (const pw of pinWorldPositions) {
    const rawV = nodeVoltage.get(pw.nodeId);
    if (rawV === undefined) continue;
    // Ground net or < 1mV threshold is strictly clamped to 0 V
    const voltage = pw.isGround || pw.nodeId === "0" || Math.abs(rawV) < 0.001 ? 0 : rawV;
    const key = `${pw.nodeId}:${pw.x}:${pw.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push({
      x: pw.x,
      y: pw.y,
      voltage,
      nodeId: key,
      componentId: pw.componentId,
      pinDir: pw.pinDir,
      compRotation: pw.compRotation,
      isGround: pw.isGround,
      isGroundSymbol: pw.isGroundSymbol,
    });
  }

  return labels;
}

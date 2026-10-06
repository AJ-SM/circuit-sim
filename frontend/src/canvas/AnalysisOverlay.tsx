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
 * Compute explicit offset for node voltage badges away from wires,
 * terminals, and component bodies to eliminate overlap:
 * - Horizontal nodes: placed above the node dot, never directly over the wire line.
 * - Vertical nodes: offset to the left of the terminal point with 14-16px padding.
 * - Ground nodes: offset to the side away from the ground symbol and traces.
 */
function computeNodeBadgeOffset(
  lbl: NodeVoltageLabel,
  textW: number
): { x: number; y: number } {
  if (lbl.isGround || lbl.nodeId.startsWith("0:")) {
    // Ground reference: offset to the side with clean clearance
    return { x: textW / 2 + 16, y: -4 };
  }

  const rot = lbl.compRotation ?? 0;
  const isVertical = rot === 90 || rot === 270;
  const dir = lbl.pinDir ?? { x: 0, y: 0 };

  if (isVertical) {
    // Vertical wire / node: offset to the left with 14px padding so it never
    // collides with the vertical wire trace or the component popup (which sits to the right)
    return {
      x: -textW / 2 - 14,
      y: dir.y < 0 ? -4 : 4,
    };
  }

  // Horizontal wire / node: place badge cleanly above the node dot (20px above),
  // with a slight outward horizontal bias away from the component body
  let biasX = 0;
  if (dir.x < 0) biasX = -8;      // left pin: bias outward to the left
  else if (dir.x > 0) biasX = 8;  // right pin: bias outward to the right

  return {
    x: biasX,
    y: -20,
  };
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
        const textW = Math.max(42, text.length * 6.5 + 14);
        const pillH = 16;
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
                rx={4}
                fill="#23272c"
                stroke={color}
                strokeWidth={1}
              />
              {/* voltage text */}
              <text
                x={0}
                y={3.8}
                textAnchor="middle"
                fontSize={8.5}
                fontFamily="var(--font-label)"
                fontWeight={700}
                                fill={color}
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
    });
  }

  return labels;
}

import type { BranchInfo } from "../api/simulate";
import { GRID_SIZE } from "../utils/geometry";

interface NodeVoltageLabel {
  x: number;
  y: number;
  voltage: number;
  nodeId: string;
}

interface Props {
  nodeLabels: NodeVoltageLabel[];
  maxVoltage: number;
}

/** Format voltage with always-visible unit */
function fmtVolts(v: number): string {
  const abs = Math.abs(v);
  if (abs < 1e-9) return "0.00 V";
  if (abs >= 1)   return `${v.toFixed(2)} V`;
  if (abs >= 1e-3) return `${(v * 1e3).toFixed(1)} mV`;
  return `${v.toExponential(1)} V`;
}

/** Color scale: cyan (GND) → green (mid) → amber (high) */
function nodeColor(v: number, maxV: number): string {
  if (maxV === 0) return "#6effb0";
  const t = Math.min(1, Math.abs(v) / maxV);
  if (t < 0.04) return "#38bdf8";   // ≈ GND  → cyan
  if (t < 0.5)  return "#6effb0";   // mid    → phosphor green
  return "#ffb454";                  // high   → amber
}

/**
 * SVG overlay: renders a clean voltage "pill" label at every resolved pin/junction.
 */
export function AnalysisOverlay({ nodeLabels, maxVoltage }: Props) {
  if (nodeLabels.length === 0) return null;

  return (
    <g className="analysis-overlay" pointerEvents="none">
      {nodeLabels.map((lbl) => {
        const px = lbl.x * GRID_SIZE;
        const py = lbl.y * GRID_SIZE;
        const isGnd = Math.abs(lbl.voltage) < 1e-6 && maxVoltage > 0;
        const text = isGnd ? "GND" : fmtVolts(lbl.voltage);
        const color = nodeColor(lbl.voltage, maxVoltage);
        const textW = Math.max(38, text.length * 6.2 + 14);
        const pillH = 15;

        return (
          <g key={lbl.nodeId} transform={`translate(${px}, ${py})`}>
            {/* dot at the node — larger with glow */}
            <circle cx={0} cy={0} r={4}
              fill={color} opacity={0.9}
              style={{ filter: `drop-shadow(0 0 5px ${color})` }}
            />
            <circle cx={0} cy={0} r={2} fill="#080c0a" />

            {/* pill label above-right */}
            <g transform="translate(7, -18)">
              {/* shadow glow */}
              <rect x={-3} y={-(pillH / 2 + 1)}
                width={textW + 2} height={pillH + 2}
                rx={5} fill={color} opacity={0.15}
                style={{ filter: "blur(4px)" }}
              />
              {/* pill background */}
              <rect x={-2} y={-pillH / 2}
                width={textW} height={pillH}
                rx={4}
                fill="rgba(5,9,7,0.92)"
                stroke={color}
                strokeWidth={0.9}
              />
              {/* voltage text */}
              <text
                x={textW / 2 - 2}
                y={4}
                textAnchor="middle"
                fontSize={isGnd ? 8 : 8.5}
                fontFamily="var(--font-mono)"
                fontWeight={700}
                letterSpacing="0.3"
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
  // "0" is always GND
  nodeVoltage.set("0", 0);

  const seen = new Set<string>();
  const labels: NodeVoltageLabel[] = [];

  for (const pw of pinWorldPositions) {
    const voltage = nodeVoltage.get(pw.nodeId);
    if (voltage === undefined) continue;
    const key = `${pw.nodeId}:${pw.x}:${pw.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push({ x: pw.x, y: pw.y, voltage, nodeId: key });
  }

  return labels;
}

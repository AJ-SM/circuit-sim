import type { ReactElement } from "react";
import { GRID_SIZE as S } from "../utils/geometry";

/** Every symbol is drawn centered on (0,0) in local grid-unit space, then
 *  the caller wraps it in a <g transform="translate/rotate/scale"> — so
 *  these components never worry about the instance's position or rotation.
 *  `stroke` should be passed through so selection/hover states recolor
 *  the artwork instead of drawing a second outline on top of it. */
export interface SymbolProps {
  stroke: string;
  strokeWidth?: number;
}

const commonProps = (stroke: string, width: number) => ({
  stroke,
  strokeWidth: width,
  fill: "none",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export function ResistorSymbol({ stroke, strokeWidth = 2 }: SymbolProps) {
  const p = commonProps(stroke, strokeWidth);
  // Leads from the pins at x=-1/1 into the zigzag body between x=-0.6/0.6.
  const zig = [
    [-0.6, 0],
    [-0.45, -0.28],
    [-0.15, 0.28],
    [0.15, -0.28],
    [0.45, 0.28],
    [0.6, 0],
  ]
    .map(([x, y]) => `${x * S},${y * S}`)
    .join(" ");
  return (
    <g>
      <line x1={-S} y1={0} x2={-0.6 * S} y2={0} {...p} />
      <polyline points={zig} {...p} />
      <line x1={0.6 * S} y1={0} x2={S} y2={0} {...p} />
    </g>
  );
}

export function CapacitorSymbol({ stroke, strokeWidth = 2 }: SymbolProps) {
  const p = commonProps(stroke, strokeWidth);
  return (
    <g>
      <line x1={-S} y1={0} x2={-0.15 * S} y2={0} {...p} />
      <line x1={-0.15 * S} y1={-0.45 * S} x2={-0.15 * S} y2={0.45 * S} {...p} />
      <line x1={0.15 * S} y1={-0.45 * S} x2={0.15 * S} y2={0.45 * S} {...p} />
      <line x1={0.15 * S} y1={0} x2={S} y2={0} {...p} />
    </g>
  );
}

export function InductorSymbol({ stroke, strokeWidth = 2 }: SymbolProps) {
  const p = commonProps(stroke, strokeWidth);
  const bumps = [-0.6, -0.2, 0.2, 0.6];
  return (
    <g>
      <line x1={-S} y1={0} x2={-0.8 * S} y2={0} {...p} />
      {bumps.map((cx) => (
        <path
          key={cx}
          d={`M ${(cx - 0.2) * S} 0 A ${0.2 * S} ${0.2 * S} 0 0 1 ${(cx + 0.2) * S} 0`}
          {...p}
        />
      ))}
      <line x1={0.8 * S} y1={0} x2={S} y2={0} {...p} />
    </g>
  );
}

export function VSourceDcSymbol({ stroke, strokeWidth = 2 }: SymbolProps) {
  const p = commonProps(stroke, strokeWidth);
  const r = 0.45 * S;
  return (
    <g>
      <line x1={-S} y1={0} x2={-r} y2={0} {...p} />
      <circle cx={0} cy={0} r={r} {...p} />
      <line x1={-0.18 * S} y1={0} x2={0.02 * S} y2={0} {...p} />
      <line x1={-0.08 * S} y1={-0.1 * S} x2={-0.08 * S} y2={0.1 * S} {...p} />
      <line x1={0.22 * S} y1={0} x2={0.42 * S} y2={0} {...p} />
      <line x1={r} y1={0} x2={S} y2={0} {...p} />
    </g>
  );
}

export function VSourceAcSymbol({ stroke, strokeWidth = 2 }: SymbolProps) {
  const p = commonProps(stroke, strokeWidth);
  const r = 0.45 * S;
  return (
    <g>
      <line x1={-S} y1={0} x2={-r} y2={0} {...p} />
      <circle cx={0} cy={0} r={r} {...p} />
      <path
        d={`M ${-0.25 * S} 0 Q ${-0.12 * S} ${-0.22 * S} 0 0 Q ${0.12 * S} ${0.22 * S} ${0.25 * S} 0`}
        {...p}
      />
      <line x1={r} y1={0} x2={S} y2={0} {...p} />
    </g>
  );
}

export function BatterySymbol({ stroke, strokeWidth = 2 }: SymbolProps) {
  const p = commonProps(stroke, strokeWidth);
  // Long plate = + (pin p1, left), short plate = - (pin p2, right).
  return (
    <g>
      <line x1={-S} y1={0} x2={-0.15 * S} y2={0} {...p} />
      <line x1={-0.15 * S} y1={-0.5 * S} x2={-0.15 * S} y2={0.5 * S} {...p} />
      <line x1={0.15 * S} y1={-0.25 * S} x2={0.15 * S} y2={0.25 * S} {...p} strokeWidth={strokeWidth * 1.8} />
      <line x1={0.15 * S} y1={0} x2={S} y2={0} {...p} />
      <line x1={-0.5 * S} y1={-0.45 * S} x2={-0.3 * S} y2={-0.45 * S} {...p} strokeWidth={strokeWidth * 0.7} />
      <line x1={-0.4 * S} y1={-0.55 * S} x2={-0.4 * S} y2={-0.35 * S} {...p} strokeWidth={strokeWidth * 0.7} />
    </g>
  );
}

export function VSourceDepSymbol({ stroke, strokeWidth = 2 }: SymbolProps) {
  const p = commonProps(stroke, strokeWidth);
  const r = 0.48 * S;
  return (
    <g>
      <line x1={-S} y1={0} x2={-r} y2={0} {...p} />
      <polygon points={`${-r},0 0,${-r} ${r},0 0,${r}`} {...p} />
      <line x1={-0.26 * S} y1={0} x2={-0.08 * S} y2={0} {...p} />
      <line x1={-0.17 * S} y1={-0.09 * S} x2={-0.17 * S} y2={0.09 * S} {...p} />
      <line x1={0.1 * S} y1={0} x2={0.28 * S} y2={0} {...p} />
      <line x1={r} y1={0} x2={S} y2={0} {...p} />
    </g>
  );
}

export function DiodeSymbol({ stroke, strokeWidth = 2 }: SymbolProps) {
  const p = commonProps(stroke, strokeWidth);
  // Triangle points from anode (p1, left) to the cathode bar (p2, right).
  return (
    <g>
      <line x1={-S} y1={0} x2={-0.3 * S} y2={0} {...p} />
      <polygon points={`${-0.3 * S},${-0.35 * S} ${0.3 * S},0 ${-0.3 * S},${0.35 * S}`} {...p} />
      <line x1={0.3 * S} y1={-0.35 * S} x2={0.3 * S} y2={0.35 * S} {...p} />
      <line x1={0.3 * S} y1={0} x2={S} y2={0} {...p} />
    </g>
  );
}

/** Bipolar transistor: base lead from pin B (-1, 0) to the bar, straight
 *  legs from the bar to the pins at (1, -1) and (1, 1), in a circle. The
 *  emitter arrow points out of the part for NPN, into it for PNP. */
function BjtSymbol({ stroke, strokeWidth = 2, npn }: SymbolProps & { npn: boolean }) {
  const p = commonProps(stroke, strokeWidth);
  const barX = -0.35;
  // NPN: emitter is the lower leg; PNP: the upper leg (pin layout in componentDefs).
  const ey = npn ? 1 : -1;
  const e0 = { x: barX, y: 0.25 * ey };
  const e1 = { x: 1, y: ey };
  const len = Math.hypot(e1.x - e0.x, e1.y - e0.y);
  const u = { x: (e1.x - e0.x) / len, y: (e1.y - e0.y) / len };
  // Arrow tip along the emitter leg, pointing out (NPN) or in (PNP).
  const t = npn ? 0.7 : 0.3;
  const dir = npn ? u : { x: -u.x, y: -u.y };
  const tip = { x: e0.x + (e1.x - e0.x) * t, y: e0.y + (e1.y - e0.y) * t };
  const back = { x: tip.x - dir.x * 0.28, y: tip.y - dir.y * 0.28 };
  const n = { x: -dir.y * 0.14, y: dir.x * 0.14 };
  const arrow = [tip, { x: back.x + n.x, y: back.y + n.y }, { x: back.x - n.x, y: back.y - n.y }]
    .map((q) => `${q.x * S},${q.y * S}`)
    .join(" ");
  return (
    <g>
      <circle cx={0.25 * S} cy={0} r={0.95 * S} {...p} strokeWidth={strokeWidth * 0.75} />
      <line x1={-S} y1={0} x2={barX * S} y2={0} {...p} />
      <line x1={barX * S} y1={-0.5 * S} x2={barX * S} y2={0.5 * S} {...p} strokeWidth={strokeWidth * 1.5} />
      <line x1={barX * S} y1={-0.25 * ey * S} x2={S} y2={-ey * S} {...p} />
      <line x1={e0.x * S} y1={e0.y * S} x2={e1.x * S} y2={e1.y * S} {...p} />
      <polygon points={arrow} {...p} fill={stroke} />
    </g>
  );
}

export function BjtNpnSymbol(props: SymbolProps) {
  return <BjtSymbol {...props} npn />;
}

export function BjtPnpSymbol(props: SymbolProps) {
  return <BjtSymbol {...props} npn={false} />;
}

/** Op-amp: triangle pointing right; inverting input (−) at (-2, -1),
 *  non-inverting (+) at (-2, 1), output at (2, 0). */
export function OpAmpSymbol({ stroke, strokeWidth = 2 }: SymbolProps) {
  const p = commonProps(stroke, strokeWidth);
  const left = -1.4, right = 1.3, half = 1.2;
  return (
    <g>
      <polygon points={`${left * S},${-half * S} ${left * S},${half * S} ${right * S},0`} {...p} />
      <line x1={-2 * S} y1={-S} x2={left * S} y2={-S} {...p} />
      <line x1={-2 * S} y1={S} x2={left * S} y2={S} {...p} />
      <line x1={right * S} y1={0} x2={2 * S} y2={0} {...p} />
      {/* − and + signs inside the triangle, next to their inputs */}
      <line x1={-1.17 * S} y1={-0.55 * S} x2={-0.83 * S} y2={-0.55 * S} {...p} strokeWidth={strokeWidth * 0.8} />
      <line x1={-1.17 * S} y1={0.55 * S} x2={-0.83 * S} y2={0.55 * S} {...p} strokeWidth={strokeWidth * 0.8} />
      <line x1={-S} y1={0.38 * S} x2={-S} y2={0.72 * S} {...p} strokeWidth={strokeWidth * 0.8} />
    </g>
  );
}

export function GroundSymbol({ stroke, strokeWidth = 2 }: SymbolProps) {
  const p = commonProps(stroke, strokeWidth);
  return (
    <g>
      <line x1={0} y1={-S} x2={0} y2={-0.2 * S} {...p} />
      <line x1={-0.4 * S} y1={-0.2 * S} x2={0.4 * S} y2={-0.2 * S} {...p} />
      <line x1={-0.25 * S} y1={0} x2={0.25 * S} y2={0} {...p} />
      <line x1={-0.1 * S} y1={0.2 * S} x2={0.1 * S} y2={0.2 * S} {...p} />
    </g>
  );
}

export const SYMBOLS: Record<string, (props: SymbolProps) => ReactElement> = {
  resistor: ResistorSymbol,
  capacitor: CapacitorSymbol,
  inductor: InductorSymbol,
  vsource_dc: VSourceDcSymbol,
  vsource_ac: VSourceAcSymbol,
  battery: BatterySymbol,
  vsource_dep: VSourceDepSymbol,
  diode: DiodeSymbol,
  bjt_npn: BjtNpnSymbol,
  bjt_pnp: BjtPnpSymbol,
  opamp: OpAmpSymbol,
  ground: GroundSymbol,
};

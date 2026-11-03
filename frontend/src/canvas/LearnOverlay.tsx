import type { LearnStep } from "../domain/learnSteps";
import type { ComponentInstance } from "../types/circuit";
import { getDef } from "../domain/componentDefs";
import { GRID_SIZE } from "../utils/geometry";

type Pt = { x: number; y: number };

const px = (p: Pt) => ({ x: p.x * GRID_SIZE, y: p.y * GRID_SIZE });
const toD = (pts: Pt[]) => pts.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");

function Arrowhead({ x, y, angle, color, size = 1 }: Pt & { angle: number; color: string; size?: number }) {
  return (
    <g transform={`translate(${x}, ${y}) rotate(${angle}) scale(${size})`}>
      <polygon points="-7,-5 8,0 -7,5" fill={color} stroke="var(--bg-canvas)" strokeWidth={1.2} />
    </g>
  );
}

/** Midpoint and heading of the longest run of a polyline (px). */
function longestRun(pts: Pt[]) {
  let best = { x: pts[0].x, y: pts[0].y, angle: 0 };
  let bestLen = -1;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > bestLen) {
      bestLen = len;
      best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI };
    }
  }
  return { ...best, len: bestLen };
}

const pillSize = (text: string, big: boolean) => {
  const fs = big ? 12 : 10.5;
  return { fs, h: big ? 22 : 17, w: Math.max(36, text.length * fs * 0.6 + (big ? 20 : 14)) };
};

/** Positions (px) for value pills, nudged apart vertically so none overlaps
 *  a loop/node badge or an earlier pill. */
function placeTags(tags: { x: number; y: number; text: string }[], badges: { x: number; y: number; text: string }[]) {
  const boxes = badges.map((b) => {
    const p = px(b);
    const { w, h } = pillSize(b.text, true);
    return { x: p.x, y: p.y, w, h };
  });
  return tags.map((t) => {
    const p = px(t);
    const { w, h } = pillSize(t.text, false);
    const box = { x: p.x, y: p.y, w, h };
    for (let guard = 0; guard < 12; guard++) {
      const hit = boxes.find(
        (o) => Math.abs(o.x - box.x) < (o.w + box.w) / 2 + 2 && Math.abs(o.y - box.y) < (o.h + box.h) / 2 + 2
      );
      if (!hit) break;
      box.y = box.y >= hit.y ? hit.y + (hit.h + box.h) / 2 + 3 : hit.y - (hit.h + box.h) / 2 - 3;
    }
    boxes.push(box);
    return { x: box.x, y: box.y };
  });
}

function Pill({ x, y, text, color, big = false }: Pt & { text: string; color: string; big?: boolean }) {
  const { fs, h, w } = pillSize(text, big);
  return (
    <g transform={`translate(${x}, ${y})`}>
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={h / 2} fill={color}
        stroke="var(--bg-canvas)" strokeWidth={1.5} />
      <text y={fs * 0.36} textAnchor="middle" fontSize={fs} fontWeight={700}
        fontFamily="var(--font-label)" fill="var(--sim-label-ink)">
        {text}
      </text>
    </g>
  );
}

interface Props {
  step: LearnStep;
  components: Map<string, ComponentInstance>;
  layer: "under" | "over";
}

/** Draws one Learn step on the schematic. The "under" layer (part halos)
 *  sits below the symbols; the "over" layer (wires, loops, arrows, values)
 *  sits on top. */
export function LearnOverlay({ step, components, layer }: Props) {
  if (layer === "under") {
    return (
      <g className="learn-under" pointerEvents="none">
        {step.halos.map((h, i) => {
          const c = components.get(h.componentId);
          if (!c) return null;
          const def = getDef(c.kind);
          const rot = ((c.rotation % 360) + 360) % 360;
          const sideways = rot === 90 || rot === 270;
          const diag = rot % 90 !== 0;
          const w = ((sideways ? def.size.h : def.size.w) + 0.9) * GRID_SIZE;
          const hgt = ((sideways ? def.size.w : def.size.h) + 0.9) * GRID_SIZE;
          const p = px(c);
          return diag ? (
            <circle key={i} cx={p.x} cy={p.y} r={Math.max(w, hgt) * 0.62} fill={h.color}
              fillOpacity={0.14} stroke={h.color} strokeWidth={1.5} />
          ) : (
            <rect key={i} x={p.x - w / 2} y={p.y - hgt / 2} width={w} height={hgt} rx={8}
              fill={h.color} fillOpacity={0.14} stroke={h.color} strokeWidth={1.5} />
          );
        })}
      </g>
    );
  }

  return (
    <g className="learn-over" pointerEvents="none">
      {/* Targeted wires: glow + solid colour, moving dashes where current flows. */}
      {step.wires.map((w, i) => {
        const pts = w.points.map(px);
        if (pts.length < 2) return null;
        const d = toD(pts);
        return (
          <g key={`w${i}`}>
            <path d={d} stroke={w.color} strokeOpacity={0.22} strokeWidth={9} fill="none"
              strokeLinecap="round" strokeLinejoin="round" />
            <path d={d} stroke={w.color} strokeWidth={2.6} fill="none"
              strokeLinecap="round" strokeLinejoin="round" />
            {w.flow && (
              <>
                <path d={d} stroke="#fff" strokeWidth={2.6} fill="none" strokeLinecap="round"
                  strokeDasharray="6 18"
                  className={w.flow === "a_to_b" ? "wire-flow-forward" : "wire-flow-reverse"}
                  style={{ animationDuration: "0.7s" }} />
              </>
            )}
          </g>
        );
      })}

      {/* Loop rings: dashes circulating in the loop-current direction. */}
      {step.rings.map((r, i) => (
        <g key={`r${i}`}>
          {r.segments.map((seg, j) => {
            const pts = seg.map(px);
            if (pts.length < 2) return null;
            const run = longestRun(pts);
            return (
              <g key={j}>
                <path d={toD(pts)} stroke={r.color} strokeWidth={3} fill="none"
                  strokeLinecap="round" strokeLinejoin="round" strokeDasharray="10 14"
                  className={r.forward ? "wire-flow-forward" : "wire-flow-reverse"}
                  style={{ animationDuration: "0.9s" }} />
                {run.len > 36 && (
                  <Arrowhead x={run.x} y={run.y} color={r.color} size={0.85}
                    angle={r.forward ? run.angle : run.angle + 180} />
                )}
              </g>
            );
          })}
        </g>
      ))}

      {step.arrows.map((a, i) => {
        const p = px(a);
        return <Arrowhead key={`a${i}`} x={p.x} y={p.y} angle={a.angle} color={a.color} size={1.25} />;
      })}

      {placeTags(step.tags, step.badges).map((p, i) => (
        <Pill key={`t${i}`} x={p.x} y={p.y} text={step.tags[i].text} color={step.tags[i].color} />
      ))}

      {step.badges.map((b, i) => {
        const p = px(b);
        return <Pill key={`b${i}`} x={p.x} y={p.y} text={b.text} color={b.color} big />;
      })}
    </g>
  );
}

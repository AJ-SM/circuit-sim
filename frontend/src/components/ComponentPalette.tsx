import { PALETTE_ORDER, getDef } from "../domain/componentDefs";
import { SYMBOLS } from "../canvas/symbols";
import { useCircuitStore } from "../store/circuitStore";

const TILE = 48;

export function ComponentPalette() {
  const addComponent = useCircuitStore((s) => s.addComponent);

  return (
    <div style={{ padding: "10px 8px", display: "flex", flexDirection: "column", gap: 8 }}>
      {PALETTE_ORDER.map((kind) => {
        const def = getDef(kind);
        const Symbol = SYMBOLS[def.symbolId];
        return (
          <div
            key={kind}
            draggable
            title={`${def.label} — drag onto canvas, or click to place`}
            onDragStart={(e) => {
              e.dataTransfer.setData("application/x-component-kind", kind);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => addComponent(kind, 0, 0)}
            className="palette-tile"
          >
            <svg width={TILE} height={TILE} viewBox={`${-TILE / 2} ${-TILE / 2} ${TILE} ${TILE}`}>
              <g transform="scale(0.7)">
                <Symbol stroke="var(--text-primary)" strokeWidth={2.2} />
              </g>
            </svg>
          </div>
        );
      })}
    </div>
  );
}

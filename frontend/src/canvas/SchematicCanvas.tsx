import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCircuitStore } from "../store/circuitStore";
import { getDef } from "../domain/componentDefs";
import { buildNetlist } from "../domain/netlist";
import { GRID_SIZE, pinDirection, resolvePinWorld, snap } from "../utils/geometry";
import { useCanvasView } from "./useCanvasView";
import { ComponentView } from "./ComponentView";
import { WireView } from "./WireView";
import { AnalysisOverlay, buildNodeLabels } from "./AnalysisOverlay";
import type { ComponentKind, PinRef } from "../types/circuit";
import type { BranchInfo } from "../api/simulate";

const DOT = 1.5;

export function SchematicCanvas() {
  const svgRef = useRef<SVGSVGElement>(null);
  const { view, screenToGrid, beginPan, updatePan, endPan, zoomAt } =
    useCanvasView(svgRef);

  const components = useCircuitStore((s) => s.components);
  const simResult = useCircuitStore((s) => s.simResult);
  const simStatus = useCircuitStore((s) => s.simStatus);
  const toggledBadgeIds = useCircuitStore((s) => s.toggledBadgeIds);
  const showAllBadges = useCircuitStore((s) => s.showAllBadges);
  const toggleComponentBadge = useCircuitStore((s) => s.toggleComponentBadge);
  const wires = useCircuitStore((s) => s.wires);
  const rawWireSegments = useCircuitStore((s) => s.rawWireSegments);
  const rawJunctions = useCircuitStore((s) => s.rawJunctions);
  const selection = useCircuitStore((s) => s.selection);
  const pendingWire = useCircuitStore((s) => s.pendingWire);
  const select = useCircuitStore((s) => s.select);
  const addComponent = useCircuitStore((s) => s.addComponent);
  const moveComponent = useCircuitStore((s) => s.moveComponent);
  const setWireRoute = useCircuitStore((s) => s.setWireRoute);
  const rotateComponent = useCircuitStore((s) => s.rotateComponent);
  const mirrorComponent = useCircuitStore((s) => s.mirrorComponent);
  const deleteSelected = useCircuitStore((s) => s.deleteSelected);
  const startWire = useCircuitStore((s) => s.startWire);
  const updateWireCursor = useCircuitStore((s) => s.updateWireCursor);
  const finishWire = useCircuitStore((s) => s.finishWire);
  const cancelWire = useCircuitStore((s) => s.cancelWire);

  const [hoveredPin, setHoveredPin] = useState<{ componentId: string; pinId: string } | null>(
    null
  );
  const dragging = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const isDraggingComponent = useRef(false);
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const wireDrag = useRef<{ id: string; axis: "x" | "y" } | null>(null);
  const panning = useRef(false);
  const wireFinalizedByPin = useRef(false);

  // --- keyboard shortcuts ---
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Delete" || e.key === "Backspace") {
        if ((e.target as HTMLElement)?.tagName === "INPUT") return;
        deleteSelected();
      } else if (e.key.toLowerCase() === "r" && selection?.type === "component") {
        rotateComponent(selection.id, e.shiftKey ? 45 : 90);
      } else if (e.key.toLowerCase() === "m" && selection?.type === "component") {
        mirrorComponent(selection.id);
      } else if (e.key === "Escape") {
        cancelWire();
        select(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, deleteSelected, rotateComponent, mirrorComponent, cancelWire, select]);

  // --- drop from palette ---
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const kind = e.dataTransfer.getData("application/x-component-kind") as ComponentKind;
      if (!kind) return;
      const { x, y } = screenToGrid(e.clientX, e.clientY);
      addComponent(kind, x, y);
    },
    [screenToGrid, addComponent]
  );

  // --- pan / deselect ---
  const onBackgroundPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button === 2 || e.button === 1) {
        panning.current = true;
        beginPan(e.clientX, e.clientY);
        return;
      }
      select(null);
    },
    [beginPan, select]
  );

  const onSvgPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (panning.current) { updatePan(e.clientX, e.clientY); return; }
      if (wireDrag.current) {
        const { x, y } = screenToGrid(e.clientX, e.clientY);
        const { id, axis } = wireDrag.current;
        setWireRoute(id, { axis, value: snap(axis === "y" ? y : x) });
        return;
      }
      if (dragging.current) {
        if (dragStartPos.current) {
          const dist = Math.hypot(e.clientX - dragStartPos.current.x, e.clientY - dragStartPos.current.y);
          if (dist > 4) {
            isDraggingComponent.current = true;
          }
        }
        const { x, y } = screenToGrid(e.clientX, e.clientY);
        moveComponent(dragging.current.id, x - dragging.current.offsetX, y - dragging.current.offsetY);
        return;
      }
      if (pendingWire) {
        const { x, y } = screenToGrid(e.clientX, e.clientY);
        updateWireCursor({ x: snap(x), y: snap(y) });
      }
    },
    [screenToGrid, moveComponent, setWireRoute, pendingWire, updateWireCursor, updatePan]
  );

  const onSvgPointerUp = useCallback(() => {
    panning.current = false;
    endPan();
    dragging.current = null;
    wireDrag.current = null;
    if (pendingWire) {
      if (wireFinalizedByPin.current) {
        wireFinalizedByPin.current = false;
      } else {
        cancelWire();
      }
    }
  }, [endPan, pendingWire, cancelWire]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => { zoomAt(e.clientX, e.clientY, e.deltaY); },
    [zoomAt]
  );

  // --- component drag-to-move ---
  const startBodyDrag = useCallback(
    (componentId: string) => (e: React.PointerEvent) => {
      e.stopPropagation();
      const comp = components.find((c) => c.id === componentId);
      if (!comp) return;
      select({ type: "component", id: componentId });
      const { x, y } = screenToGrid(e.clientX, e.clientY);
      dragging.current = { id: componentId, offsetX: x - comp.x, offsetY: y - comp.y };
      dragStartPos.current = { x: e.clientX, y: e.clientY };
      isDraggingComponent.current = false;
    },
    [components, screenToGrid, select]
  );

  // --- pin wire ---
  const onPinPointerDown = useCallback(
    (pin: PinRef, e: React.PointerEvent) => {
      if (pendingWire) {
        e.stopPropagation();
        wireFinalizedByPin.current = true;
        finishWire(pin);
        return;
      }
      const { x, y } = screenToGrid(e.clientX, e.clientY);
      startWire(pin, { x: snap(x), y: snap(y) });
    },
    [pendingWire, screenToGrid, startWire, finishWire]
  );

  const onPinPointerUp = useCallback(
    (pin: PinRef) => (e: React.PointerEvent) => {
      if (!pendingWire) return;
      e.stopPropagation();
      wireFinalizedByPin.current = true;
      finishWire(pin);
    },
    [pendingWire, finishWire]
  );

  // --- helpers: pin world position ---
  const componentPinWorld = (componentId: string, pinId: string) => {
    const comp = components.find((c) => c.id === componentId);
    if (!comp) return { x: 0, y: 0 };
    const def = getDef(comp.kind);
    const pinDef = def.pins.find((p) => p.id === pinId)!;
    return resolvePinWorld(comp, pinDef);
  };

  const componentPinDir = (componentId: string, pinId: string) => {
    const comp = components.find((c) => c.id === componentId);
    const pinDef = comp && getDef(comp.kind).pins.find((p) => p.id === pinId);
    return comp && pinDef ? pinDirection(comp, pinDef) : undefined;
  };

  const isPinConnected = (componentId: string, pinId: string) =>
    wires.some(
      (w) =>
        (w.from.componentId === componentId && w.from.pinId === pinId) ||
        (w.to.componentId === componentId && w.to.pinId === pinId)
    );

  // ── Simulation analysis maps ──────────────────────────────────────────────

  /** branch_analysis keyed by component UUID (not refId) */
  const branchMap = useMemo(() => {
    const m = new Map<string, BranchInfo>();
    if (simResult?.branch_analysis) {
      for (const b of simResult.branch_analysis) {
        m.set(b.component_id, b);
      }
    }
    return m;
  }, [simResult]);

  /**
   * Build netlist-level connectivity: pinKey → netName
   * (same union-find as buildNetlist, but we just need the final mapping).
   */
  const pinNetMap = useMemo(() => {
    const netlist = buildNetlist(components, wires);
    const map = new Map<string, string>(); // "compId:pinId" → netName
    for (const nc of netlist.components) {
      const def = getDef(components.find((c) => c.id === nc.id)!.kind);
      def.pins.forEach((pin, idx) => {
        map.set(`${nc.id}:${pin.id}`, nc.nodes[idx]);
      });
    }
    // ground components map to "0"
    for (const c of components) {
      if (c.kind === "ground") {
        map.set(`${c.id}:p1`, "0");
      }
    }
    return map;
  }, [components, wires]);

  /** nodeId → voltage (from branch_analysis) */
  const nodeVoltageMap = useMemo(() => {
    const m = new Map<string, number>();
    if (simResult?.branch_analysis) {
      for (const b of simResult.branch_analysis) {
        m.set(b.node_a, b.voltage_a);
        m.set(b.node_b, b.voltage_b);
      }
    }
    return m;
  }, [simResult]);

  /** Maximum signed node voltage — used as the top of the color scale.
   *  Ground is 0 V, so we only care about the highest positive potential. */
  const maxVoltage = useMemo(() => {
    return Array.from(nodeVoltageMap.values()).reduce(
      (max, v) => Math.max(max, v),
      0
    );
  }, [nodeVoltageMap]);

  /**
   * Per-wire: { currentAmperes, currentDirection, avgVoltage }
   * A wire is associated with the component whose branch-analysis it
   * participates in (from-pin side, component lookup).
   */
  const wireAnalysis = useMemo(() => {
    type WireInfo = {
      currentAmperes?: number;
      currentDirection?: "a_to_b" | "b_to_a" | "none";
      avgVoltage?: number;
    };
    const result = new Map<string, WireInfo>();

    for (const w of wires) {
      const fromNet = pinNetMap.get(`${w.from.componentId}:${w.from.pinId}`);
      const toNet = pinNetMap.get(`${w.to.componentId}:${w.to.pinId}`);
      const va = fromNet !== undefined ? nodeVoltageMap.get(fromNet) : undefined;
      const vb = toNet !== undefined ? nodeVoltageMap.get(toNet) : undefined;
      const avgV = va !== undefined && vb !== undefined ? (va + vb) / 2 : va ?? vb;

      // Find branch info: look at components connected to both ends, pick the
      // one that has both pins on this wire's nets.
      let current: number | undefined;
      let direction: "a_to_b" | "b_to_a" | "none" | undefined;

      // Try from-component first
      const fromBranch = branchMap.get(w.from.componentId);
      const toBranch = branchMap.get(w.to.componentId);
      const chosen = fromBranch ?? toBranch;
      if (chosen) {
        current = chosen.current_a;
        // Direction relative to wire: if branch direction is a_to_b and the
        // from-pin is node_a, then current flows from→to.
        const fromIsA =
          fromBranch &&
          fromNet !== undefined &&
          fromBranch.node_a === fromNet;
        if (fromIsA) {
          direction = chosen.direction;
        } else {
          // flip
          direction =
            chosen.direction === "a_to_b"
              ? "b_to_a"
              : chosen.direction === "b_to_a"
              ? "a_to_b"
              : "none";
        }
      }

      result.set(w.id, {
        currentAmperes: current !== undefined ? Math.abs(current) : undefined,
        currentDirection: direction,
        avgVoltage: avgV,
      });
    }
    return result;
  }, [wires, pinNetMap, nodeVoltageMap, branchMap]);

  /** Node voltage labels: collect all pin positions with known voltages and orientations */
  const nodeLabels = useMemo(() => {
    if (!simResult?.branch_analysis) return [];
    const pinPositions = components.flatMap((c) => {
      const def = getDef(c.kind);
      return def.pins.map((pin) => {
        const world = resolvePinWorld(c, pin);
        const nodeId = pinNetMap.get(`${c.id}:${pin.id}`) ?? "";
        const dir = pinDirection(c, pin);
        return {
          componentId: c.id,
          pinId: pin.id,
          nodeId,
          x: world.x,
          y: world.y,
          pinDir: dir,
          compRotation: c.rotation,
          isGround: c.kind === "ground" || nodeId === "0",
        };
      });
    });
    return buildNodeLabels(simResult.branch_analysis, pinPositions);
  }, [simResult, components, pinNetMap]);

  const analysisActive = simStatus === "done" && !!simResult?.branch_analysis;

  /** Memoised Set of component IDs whose badge is currently visible */
  const badgeVisibleIds = useMemo(() => {
    if (!analysisActive) return null;
    if (showAllBadges) return new Set(components.map((c) => c.id));
    return new Set(toggledBadgeIds);
  }, [analysisActive, showAllBadges, toggledBadgeIds, components]);

  return (
    <svg
      ref={svgRef}
      width="100%"
      height="100%"
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onSvgPointerMove}
      onPointerUp={onSvgPointerUp}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
      style={{ display: "block", background: "var(--bg-canvas)", touchAction: "none" }}
    >
      <defs>
        <pattern id="grid-dots" width={GRID_SIZE} height={GRID_SIZE} patternUnits="userSpaceOnUse">
          <circle cx={GRID_SIZE / 2} cy={GRID_SIZE / 2} r={DOT} fill="var(--line-grid)" />
        </pattern>
      </defs>

      <g transform={`translate(${view.panX}, ${view.panY}) scale(${view.zoom})`}>
        <rect x={-4000} y={-4000} width={8000} height={8000} fill="url(#grid-dots)" />

        {/* ── Raw wire segments from loaded netlist JSON ─── */}
        {rawWireSegments.length > 0 && (
          <g
            className="raw-wires-layer"
            pointerEvents="none"
            opacity={wires.length > 0 ? 0.45 : 1}
          >
            {rawWireSegments.map((seg, i) => (
              <line
                key={i}
                x1={seg.x1 * GRID_SIZE}
                y1={seg.y1 * GRID_SIZE}
                x2={seg.x2 * GRID_SIZE}
                y2={seg.y2 * GRID_SIZE}
                stroke="var(--phosphor)"
                strokeWidth={2}
                strokeLinecap="round"
              />
            ))}
            {rawJunctions.map((jct, i) => (
              <circle
                key={i}
                cx={jct.x * GRID_SIZE}
                cy={jct.y * GRID_SIZE}
                r={4}
                fill="var(--phosphor)"
              />
            ))}
          </g>
        )}

        {/* ── Wires with analysis overlay ─── */}
        {wires.map((w) => {
          const analysis = wireAnalysis.get(w.id);
          return (
            <WireView
              key={w.id}
              points={[
                componentPinWorld(w.from.componentId, w.from.pinId),
                componentPinWorld(w.to.componentId, w.to.pinId),
              ]}
              dirs={[
                componentPinDir(w.from.componentId, w.from.pinId),
                componentPinDir(w.to.componentId, w.to.pinId),
              ]}
              selected={selection?.type === "wire" && selection.id === w.id}
              route={w.route}
              onPointerDown={(e, axis) => {
                e.stopPropagation();
                select({ type: "wire", id: w.id });
                if (axis && e.button === 0) wireDrag.current = { id: w.id, axis };
              }}
              currentAmperes={analysisActive ? analysis?.currentAmperes : undefined}
              currentDirection={analysisActive ? analysis?.currentDirection : undefined}
              avgVoltage={analysisActive ? analysis?.avgVoltage : undefined}
              maxVoltage={analysisActive ? maxVoltage : undefined}
              showCurrentLabel={
                analysisActive &&
                (
                  (badgeVisibleIds?.has(w.from.componentId) ?? false) ||
                  (badgeVisibleIds?.has(w.to.componentId) ?? false)
                )
              }
            />
          );
        })}

        {pendingWire && (
          <WireView
            points={[componentPinWorld(pendingWire.from.componentId, pendingWire.from.pinId), pendingWire.cursor]}
            dirs={[componentPinDir(pendingWire.from.componentId, pendingWire.from.pinId)]}
            selected={false}
            onPointerDown={() => {}}
          />
        )}

        {components.map((c) => (
          <ComponentView
            key={c.id}
            component={c}
            branchInfo={analysisActive ? branchMap.get(c.id) : undefined}
            showBranchBadge={analysisActive && (badgeVisibleIds?.has(c.id) ?? false)}
            onToggleBranchBadge={analysisActive ? () => toggleComponentBadge(c.id) : undefined}
            selected={selection?.type === "component" && selection.id === c.id}
            hoveredPin={hoveredPin?.componentId === c.id ? hoveredPin.pinId : null}
            onPointerDownBody={startBodyDrag(c.id)}
            onClickBody={(e) => {
              e.stopPropagation();
              if (isDraggingComponent.current) return;
              if (analysisActive && branchMap.has(c.id)) {
                toggleComponentBadge(c.id);
              }
            }}
            onPinPointerDown={(pin, e) => onPinPointerDown(pin, e)}
            onPinPointerUp={(pin, e) => onPinPointerUp(pin)(e)}
            onPinPointerEnter={(pinId) => setHoveredPin({ componentId: c.id, pinId })}
            onPinPointerLeave={() => setHoveredPin(null)}
            isPinConnected={(pinId) => isPinConnected(c.id, pinId)}
          />
        ))}

        {/* ── Node voltage labels (shown only for toggled components) ─── */}
        {analysisActive && (
          <AnalysisOverlay
            nodeLabels={nodeLabels}
            maxVoltage={maxVoltage}
            visibleComponentIds={badgeVisibleIds}
          />
        )}
      </g>
    </svg>
  );
}

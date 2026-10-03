import { useCallback, useRef, useState } from "react";
import { GRID_SIZE } from "../utils/geometry";

export interface ViewState {
  panX: number;
  panY: number;
  zoom: number;
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;

/** Owns pan/zoom for the schematic canvas and the math to convert a
 *  mouse event's screen position into world grid-unit coordinates.
 *  Kept out of global state on purpose: this is view-only, never saved. */
export function useCanvasView(svgRef: React.RefObject<SVGSVGElement | null>) {
  const [view, setView] = useState<ViewState>({ panX: 0, panY: 0, zoom: 1 });
  const dragState = useRef<{ startX: number; startY: number; origin: ViewState } | null>(
    null
  );

  const screenToGrid = useCallback(
    (clientX: number, clientY: number) => {
      const rect = svgRef.current?.getBoundingClientRect();
      const sx = clientX - (rect?.left ?? 0);
      const sy = clientY - (rect?.top ?? 0);
      const worldPxX = (sx - view.panX) / view.zoom;
      const worldPxY = (sy - view.panY) / view.zoom;
      return { x: worldPxX / GRID_SIZE, y: worldPxY / GRID_SIZE };
    },
    [view, svgRef]
  );

  const beginPan = useCallback(
    (clientX: number, clientY: number) => {
      dragState.current = { startX: clientX, startY: clientY, origin: view };
    },
    [view]
  );

  const updatePan = useCallback((clientX: number, clientY: number) => {
    if (!dragState.current) return;
    const { startX, startY, origin } = dragState.current;
    setView({
      ...origin,
      panX: origin.panX + (clientX - startX),
      panY: origin.panY + (clientY - startY),
    });
  }, []);

  const endPan = useCallback(() => {
    dragState.current = null;
  }, []);

  const zoomAt = useCallback(
    (clientX: number, clientY: number, deltaY: number) => {
      const rect = svgRef.current?.getBoundingClientRect();
      const sx = clientX - (rect?.left ?? 0);
      const sy = clientY - (rect?.top ?? 0);
      setView((v) => {
        const nextZoom = clamp(v.zoom * (deltaY > 0 ? 0.9 : 1.1), MIN_ZOOM, MAX_ZOOM);
        // Keep the point under the cursor stationary while zooming.
        const worldX = (sx - v.panX) / v.zoom;
        const worldY = (sy - v.panY) / v.zoom;
        return {
          zoom: nextZoom,
          panX: sx - worldX * nextZoom,
          panY: sy - worldY * nextZoom,
        };
      });
    },
    [svgRef]
  );

  const resetView = useCallback(() => setView({ panX: 0, panY: 0, zoom: 1 }), []);

  return { view, screenToGrid, beginPan, updatePan, endPan, zoomAt, resetView };
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

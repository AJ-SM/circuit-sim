import { useCallback, useRef, useState } from "react";
import { GRID_SIZE } from "../utils/geometry";

export interface ViewState {
  panX: number;
  panY: number;
  zoom: number;
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;
/** Zoom-in/out button step. */
const ZOOM_STEP = 1.25;
/** Fit never magnifies past this, so a tiny circuit isn't blown up. */
const FIT_MAX_ZOOM = 1.75;
/** Screen px kept clear around the circuit when fitting. */
const FIT_PADDING = 48;

export { MIN_ZOOM, MAX_ZOOM };

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

  /** Zoom by `factor` about the centre of the canvas (toolbar buttons). */
  const zoomBy = useCallback(
    (factor: number) => {
      const rect = svgRef.current?.getBoundingClientRect();
      const sx = (rect?.width ?? 0) / 2;
      const sy = (rect?.height ?? 0) / 2;
      setView((v) => {
        const nextZoom = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM);
        const worldX = (sx - v.panX) / v.zoom;
        const worldY = (sy - v.panY) / v.zoom;
        return { zoom: nextZoom, panX: sx - worldX * nextZoom, panY: sy - worldY * nextZoom };
      });
    },
    [svgRef]
  );
  const zoomIn = useCallback(() => zoomBy(ZOOM_STEP), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / ZOOM_STEP), [zoomBy]);

  /** Centre `bounds` (world px) in the canvas, zoomed to fit. With no
   *  bounds (empty canvas) the view goes back to the origin at 100 %. */
  const fitTo = useCallback(
    (bounds: { x: number; y: number; width: number; height: number } | null) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect || !bounds || bounds.width <= 0 || bounds.height <= 0) {
        setView({ panX: 0, panY: 0, zoom: 1 });
        return;
      }
      const availW = Math.max(1, rect.width - FIT_PADDING * 2);
      const availH = Math.max(1, rect.height - FIT_PADDING * 2);
      const zoom = clamp(
        Math.min(availW / bounds.width, availH / bounds.height, FIT_MAX_ZOOM),
        MIN_ZOOM,
        MAX_ZOOM
      );
      const cx = bounds.x + bounds.width / 2;
      const cy = bounds.y + bounds.height / 2;
      setView({ zoom, panX: rect.width / 2 - cx * zoom, panY: rect.height / 2 - cy * zoom });
    },
    [svgRef]
  );

  const resetView = useCallback(() => setView({ panX: 0, panY: 0, zoom: 1 }), []);

  return {
    view, screenToGrid, beginPan, updatePan, endPan, zoomAt,
    zoomIn, zoomOut, fitTo, resetView,
  };
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

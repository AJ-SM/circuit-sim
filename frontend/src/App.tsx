import { useState } from "react";
import { Toolbar } from "./components/Toolbar";
import { ComponentPalette } from "./components/ComponentPalette";
import { SchematicCanvas } from "./canvas/SchematicCanvas";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { DisplayPanel } from "./components/DisplayPanel";
import { SimulationPanel } from "./components/SimulationPanel";
import { BranchAnalysisPanel } from "./components/BranchAnalysisPanel";
import { CircuitJsViewer } from "./components/CircuitJsViewer";
import { DrawCircuitOverlay } from "./components/DrawCircuitOverlay";
import { useCircuitStore } from "./store/circuitStore";

export type ViewMode = "canvas" | "circuitjs";
type SidebarTab = "inspector" | "branches";

const SIDEBAR_TAB_KEY = "sidebar-tab";

function readSidebarTab(): SidebarTab {
  try {
    return localStorage.getItem(SIDEBAR_TAB_KEY) === "branches" ? "branches" : "inspector";
  } catch {
    return "inspector";
  }
}

export default function App() {
  const [viewMode, setViewMode] = useState<ViewMode>("canvas");
  const [drawing, setDrawing] = useState(false);
  const [pickImage, setPickImage] = useState(false);
  const netlistRaw = useCircuitStore((s) => s.netlistRaw);
  const sceneVersion = useCircuitStore((s) => s.sceneVersion);
  const branchCount = useCircuitStore((s) =>
    s.simStatus === "done" ? s.simResult?.branch_analysis?.length ?? 0 : 0
  );
  const [sidebarTab, setSidebarTabState] = useState<SidebarTab>(readSidebarTab);
  const setSidebarTab = (tab: SidebarTab) => {
    setSidebarTabState(tab);
    try {
      localStorage.setItem(SIDEBAR_TAB_KEY, tab);
    } catch {
      /* storage unavailable: tab still switches for this session */
    }
  };

  return (
    <div className="app-shell">
      <div className="app-titlebar">
        <Toolbar
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          drawing={drawing}
          onDrawClick={() => {
            setViewMode("canvas");
            setPickImage(false);
            setDrawing(true);
          }}
          onLoadImageClick={() => {
            setViewMode("canvas");
            setPickImage(true);
            setDrawing(true);
          }}
        />
      </div>
      <div className="app-palette">
        <ComponentPalette />
      </div>
      <div className="app-canvas-area">
        {viewMode === "canvas" ? (
          // Remount per scene so a new circuit starts from a fresh view.
          <SchematicCanvas key={sceneVersion} />
        ) : (
          <CircuitJsViewer netlistJson={netlistRaw} />
        )}
        {drawing && <DrawCircuitOverlay pickImageOnOpen={pickImage} onClose={() => setDrawing(false)} />}
      </div>
      <div className="app-inspector">
        <div className="sidebar-head">
        <div className="sidebar-tabs" role="tablist" aria-label="Sidebar">
          <button
            role="tab"
            aria-selected={sidebarTab === "inspector"}
            className={`sidebar-tab${sidebarTab === "inspector" ? " active" : ""}`}
            onClick={() => setSidebarTab("inspector")}
          >
            Inspector
          </button>
          <button
            role="tab"
            aria-selected={sidebarTab === "branches"}
            className={`sidebar-tab${sidebarTab === "branches" ? " active" : ""}`}
            onClick={() => setSidebarTab("branches")}
          >
            Branch Analysis
            {branchCount > 0 && <span className="sidebar-tab-count">{branchCount}</span>}
          </button>
        </div>
        </div>
        {sidebarTab === "inspector" ? (
          <>
            <PropertiesPanel />
            <DisplayPanel />
            <SimulationPanel />
          </>
        ) : (
          <BranchAnalysisPanel />
        )}
      </div>
    </div>
  );
}

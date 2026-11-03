import { useEffect, useRef, useState } from "react";
import { useCircuitStore } from "../store/circuitStore";
import { LEARN_MODE_LABEL, type LearnMode } from "../domain/learnSteps";

const OPTIONS: { mode: LearnMode; hint: string }[] = [
  { mode: "kcl", hint: "Current in = current out, node by node" },
  { mode: "kvl", hint: "Voltages around each loop sum to zero" },
  { mode: "nodal", hint: "Solve every node voltage, one equation at a time" },
];

interface Props {
  /** Called when a walkthrough starts (the canvas view must be showing). */
  onStart: () => void;
}

/** Toolbar "Learn" dropdown: pick a KCL / KVL / nodal walkthrough. */
export function LearnMenu({ onStart }: Props) {
  const learnMode = useCircuitStore((s) => s.learnMode);
  const setLearnMode = useCircuitStore((s) => s.setLearnMode);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  function start(mode: LearnMode) {
    setOpen(false);
    onStart();
    setLearnMode(mode);
    const { simStatus, components, runSimulate } = useCircuitStore.getState();
    // The walkthrough is built from simulation results: get them if missing.
    if (simStatus !== "done" && simStatus !== "running" && components.length > 0) {
      runSimulate().catch(() => {});
    }
  }

  return (
    <div className="learn-menu" ref={ref}>
      <button
        className={`btn btn-load${learnMode ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="Step-by-step KCL, KVL and nodal analysis on this circuit"
      >
        {learnMode ? `Learn: ${LEARN_MODE_LABEL[learnMode]}` : "Learn"} ▾
      </button>
      {open && (
        <div className="learn-menu-list" role="menu">
          {OPTIONS.map((o) => (
            <button
              key={o.mode}
              role="menuitemradio"
              aria-checked={learnMode === o.mode}
              className={`learn-menu-item${learnMode === o.mode ? " active" : ""}`}
              onClick={() => start(o.mode)}
            >
              <span className="learn-menu-name">{LEARN_MODE_LABEL[o.mode]}</span>
              <span className="learn-menu-hint">{o.hint}</span>
            </button>
          ))}
          {learnMode && (
            <button
              role="menuitem"
              className="learn-menu-item learn-menu-exit"
              onClick={() => {
                setOpen(false);
                setLearnMode(null);
              }}
            >
              <span className="learn-menu-name">Exit Learn mode</span>
              <span className="learn-menu-hint">Bring back the normal animations</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

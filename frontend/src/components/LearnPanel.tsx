import { useEffect } from "react";
import { useCircuitStore } from "../store/circuitStore";
import { LEARN_MODE_LABEL, type LearnMode } from "../domain/learnSteps";
import { useLearnSteps } from "../canvas/useLearnSteps";

/** Sidebar card while Learn mode is on: the current step's explanation,
 *  its equation, and Back / Next to move one loop or node at a time. */
export function LearnPanel({ mode }: { mode: LearnMode }) {
  const { steps, index } = useLearnSteps();
  const setLearnStep = useCircuitStore((s) => s.setLearnStep);
  const setLearnMode = useCircuitStore((s) => s.setLearnMode);
  const simStatus = useCircuitStore((s) => s.simStatus);
  const simError = useCircuitStore((s) => s.simError);
  const runSimulate = useCircuitStore((s) => s.runSimulate);
  const componentCount = useCircuitStore((s) => s.components.length);

  const count = steps?.length ?? 0;
  const step = steps?.[index];

  // ← / → step through, Esc leaves Learn mode.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "ArrowRight" && index < count - 1) setLearnStep(index + 1);
      else if (e.key === "ArrowLeft" && index > 0) setLearnStep(index - 1);
      else if (e.key === "Escape") setLearnMode(null);
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, count, setLearnStep, setLearnMode]);

  return (
    <section className="learn-panel" aria-label={`Learn ${LEARN_MODE_LABEL[mode]}`}>
      <header className="learn-head">
        <span className="learn-mode">Learn · {LEARN_MODE_LABEL[mode]}</span>
        {step && <span className="learn-kicker">{step.kicker}</span>}
        <button className="learn-close" onClick={() => setLearnMode(null)}
          title="Exit Learn mode (Esc)" aria-label="Exit Learn mode">×</button>
      </header>

      {!step ? (
        <div className="learn-body">
          <p>
            {componentCount === 0
              ? "Place or load a circuit first, then run the simulation — the walkthrough uses its results."
              : simStatus === "running"
                ? "Simulating…"
                : simStatus === "error"
                  ? `The simulation failed: ${simError ?? "unknown error"}`
                  : "The walkthrough uses the simulation's voltages and currents. Run the simulation to start."}
          </p>
          {componentCount > 0 && simStatus !== "running" && (
            <button className="btn btn-load" onClick={() => runSimulate()}>Run simulation</button>
          )}
        </div>
      ) : (
        <>
          <div className="learn-body">
            <h3 className="learn-title">{step.title}</h3>
            {step.body.map((p, i) => <p key={i}>{p}</p>)}

            {step.details && step.details.length > 0 && (
              <ul className="learn-details">
                {step.details.map((d, i) => (
                  <li key={i}>
                    <span className="learn-dot" style={{ background: d.color ?? "var(--ui-text-dim)" }} />
                    <span className="learn-detail-label" style={{ color: d.color }}>{d.label}</span>
                    <span className="learn-detail-text">{d.text}</span>
                  </li>
                ))}
              </ul>
            )}

            {step.equation && (
              <div className="learn-equation">
                {step.equation.map((t, i) =>
                  t.color ? (
                    <span key={i} className="learn-term" style={{ borderColor: t.color, color: t.color }}>{t.text}</span>
                  ) : (
                    <span key={i} className="learn-op">{t.text}</span>
                  )
                )}
              </div>
            )}
            {step.result && <div className="learn-result">{step.result}</div>}
          </div>

          <footer className="learn-foot">
            <button className="btn btn-load" disabled={index === 0}
              onClick={() => setLearnStep(index - 1)} title="Previous step (←)">◀ Back</button>
            <div className="learn-progress" aria-label={`Step ${index + 1} of ${count}`}>
              {steps!.map((_, i) => (
                <button key={i} className={`learn-pip${i === index ? " active" : ""}`}
                  onClick={() => setLearnStep(i)} aria-label={`Go to step ${i + 1}`} />
              ))}
            </div>
            <button className="btn btn-load" disabled={index >= count - 1}
              onClick={() => setLearnStep(index + 1)} title="Next step (→)">Next ▶</button>
          </footer>
        </>
      )}
    </section>
  );
}

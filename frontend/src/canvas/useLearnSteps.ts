import { useMemo } from "react";
import { useCircuitStore } from "../store/circuitStore";
import { buildLearnSteps, type LearnStep } from "../domain/learnSteps";
import type { BranchInfo } from "../api/simulate";

/** The active Learn walkthrough: its steps (null until there are simulation
 *  results to teach from) and the clamped current step index. Shared by the
 *  canvas overlay and the sidebar card. */
export function useLearnSteps(): { steps: LearnStep[] | null; index: number } {
  const learnMode = useCircuitStore((s) => s.learnMode);
  const learnStep = useCircuitStore((s) => s.learnStep);
  const components = useCircuitStore((s) => s.components);
  const wires = useCircuitStore((s) => s.wires);
  const simStatus = useCircuitStore((s) => s.simStatus);
  const simResult = useCircuitStore((s) => s.simResult);
  const simMode = useCircuitStore((s) => s.simConfig.mode);

  const steps = useMemo(() => {
    if (!learnMode || simStatus !== "done" || !simResult?.branch_analysis) return null;
    const branchMap = new Map<string, BranchInfo>(
      simResult.branch_analysis.map((b) => [b.component_id, b])
    );
    return buildLearnSteps(learnMode, components, wires, branchMap, simMode === "ac");
  }, [learnMode, simStatus, simResult, components, wires, simMode]);

  return { steps, index: steps ? Math.min(learnStep, steps.length - 1) : 0 };
}

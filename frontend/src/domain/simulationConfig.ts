export type AnalysisMode = "dc" | "tran" | "ac";

export interface TransientConfig {
  stepSeconds: number;
  stopSeconds: number;
}

export interface AcConfig {
  startHz: number;
  stopHz: number;
  pointsPerDecade: number;
}

export interface SimulationConfig {
  mode: AnalysisMode;
  tran: TransientConfig;
  ac: AcConfig;
}

export const DEFAULT_SIM_CONFIG: SimulationConfig = {
  mode: "tran",
  tran: { stepSeconds: 1e-6, stopSeconds: 1e-3 },
  ac: { startHz: 1, stopHz: 1e6, pointsPerDecade: 20 },
};

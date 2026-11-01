/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SIMULATE_URL?: string;
  readonly VITE_GENERATE_URL?: string;
  readonly VITE_JOB_URL?: string;
  readonly VITE_DETECT_URL?: string;
  readonly VITE_MODELS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
